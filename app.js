/**
 * app.js — Логика планировщика АГНКС
 *
 * Зависимости (подключаются в index.html):
 *   - Яндекс Карты API (ymaps)
 *   - Turf.js           (turf)
 *   - stations.json     (загружается через fetch)
 *
 * Оглавление:
 *   1. Константы
 *   2. Состояние приложения
 *   3. Инициализация
 *   4. Загрузка и парсинг станций
 *   5. Привязка событий UI
 *   6. Построение маршрута
 *   7. Боковая панель (список заездов)
 *   8. Фильтрация и отрисовка заправок
 *   9. Публичные функции (вызываются из HTML балунов)
 *  10. Вспомогательные функции
 */


/* ─── 1. Константы ──────────────────────────────────────────── */

/** Начальный центр карты: Ставропольский край */
const MAP_CENTER = [45.03, 39.02];
const MAP_ZOOM = 5;

/** Яндекс-пресеты иконок заправок */
const ICON_STATION_DEFAULT = 'islands#blueIcon';
const ICON_STATION_ADDED = 'islands#redIcon';

/** Стиль маршрутной линии */
const ROUTE_LINE_COLOR = '#1e98ff';
const ROUTE_LINE_WIDTH = 5;
const ROUTE_LINE_OPACITY = 0.8;


/* ─── 2. Состояние приложения ───────────────────────────────── */

let myMap;          // экземпляр ymaps.Map
let objectManager;  // кластеризатор меток
let routeObj = null;// текущая линия маршрута на карте

/**
 * Все заправки из stations.js в нормализованном виде.
 * @type {Array<GeoJSON.Feature>}
 */
let allFeatures = [];

/**
 * Полный маршрут (с заездами) в формате Turf — [lon, lat][].
 * Яндекс возвращает [lat, lon], поэтому координаты инвертируются перед сохранением.
 */
let routeGeoJsonCoords = null;

/**
 * Первоначальный маршрут A→Б без заездов.
 * Используется как «линейка» для сортировки промежуточных заправок
 * в правильном порядке вдоль трассы.
 */
let baseRouteGeoJsonCoords = null;

let originGeo = null; // [lat, lon] — стартовая точка
let destGeo = null; // [lat, lon] — конечная точка
let originName = '';
let destName = '';

/**
 * Промежуточные заправки, выбранные пользователем.
 * @type {Array<{id: number, name: string, lat: number, lon: number}>}
 */
let selectedWaypoints = [];


/* ─── 3. Инициализация ──────────────────────────────────────── */

ymaps.ready(init);

async function init() {
    myMap = new ymaps.Map('map', {
        center: MAP_CENTER,
        zoom: MAP_ZOOM,
        controls: ['zoomControl', 'fullscreenControl']
    });

    // ObjectManager кластеризует метки заправок для быстрой отрисовки
    objectManager = new ymaps.ObjectManager({
        clusterize: true,
        gridSize: 40,
        clusterDisableClickZoom: false
    });
    objectManager.clusters.options.set('preset', 'islands#blueClusterIcons');
    myMap.geoObjects.add(objectManager);

    await loadStations();
    bindUIEvents();
}


/* ─── 4. Загрузка и парсинг станций ────────────────────────── */

/**
 * Загружает stations.json через fetch и заполняет allFeatures.
 * Async: карта рендерится сразу, данные подгружаются в фоне.
 */
async function loadStations() {
    setStatus('Загрузка базы станций…');

    let data;
    try {
        const response = await fetch('stations.json');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        data = await response.json();
    } catch (err) {
        setStatus(`Ошибка загрузки stations.json: ${err.message}`);
        return;
    }

    data.forEach(function (item) {
        if (item.type === 'Feature' && item.geometry && item.properties) {
            allFeatures.push(parseStation(item));
        }
    });

    setStatus('');
    filterAndRenderStations();
}

/**
 * Превращает сырую GeoJSON-фичу из stations.json в чистый объект
 * с именем и адресом без HTML-тегов.
 *
 * @param {object} item — элемент из stationsData
 * @returns {GeoJSON.Feature}
 */
function parseStation(item) {
    const nameClean = stripHtml(item.properties.hintContent || 'АГНКС');
    let addressClean = stripHtml(item.properties.balloonContentBody || '');

    // В балунах Яндекса иногда остаётся слово «подробнее» — убираем
    addressClean = addressClean.replace('подробнее', '').trim();

    return {
        type: 'Feature',
        id: item.id,
        geometry: {
            type: 'Point',
            coordinates: item.geometry.coordinates // [lat, lon] — формат Яндекса
        },
        properties: {
            nameClean,
            addressClean,
            clusterCaption: item.properties.clusterCaption,
            hintContent: nameClean,
            rawCoords: item.geometry.coordinates
        }
    };
}

/**
 * Извлекает чистый текст из строки с HTML.
 * @param {string} html
 * @returns {string}
 */
function stripHtml(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    return div.textContent || div.innerText || '';
}


/* ─── 5. Привязка событий UI ────────────────────────────────── */

function bindUIEvents() {
    const showAllCheckbox = document.getElementById('show-all');
    const distanceSlider = document.getElementById('distance-slider');
    const distanceValLabel = document.getElementById('distance-val');
    const sliderGroup = document.getElementById('distance-slider-group');

    // Переключаем видимость ползунка и перерисовываем метки
    showAllCheckbox.addEventListener('change', function (e) {
        sliderGroup.style.display = e.target.checked ? 'none' : 'block';
        filterAndRenderStations();
    });

    // Обновляем числовой лейбл рядом с ползунком (без запроса маршрута)
    distanceSlider.addEventListener('input', function (e) {
        distanceValLabel.innerText = e.target.value;
    });

    // Перерисовываем метки только когда пользователь отпустил ползунок
    distanceSlider.addEventListener('change', function () {
        filterAndRenderStations();
    });

    document.getElementById('build-route').addEventListener('click', onBuildRouteClick);
}


/* ─── 6. Построение маршрута ────────────────────────────────── */

/** Обработчик кнопки «Проложить маршрут». */
function onBuildRouteClick() {
    const fromInput = document.getElementById('route-from').value.trim();
    const toInput = document.getElementById('route-to').value.trim();

    if (!fromInput || !toInput) {
        alert('Заполните поля «Откуда» и «Куда»');
        return;
    }

    setStatus('Геокодирование адресов...');

    // Параллельно определяем координаты обеих точек
    Promise.all([
        ymaps.geocode(fromInput),
        ymaps.geocode(toInput)
    ]).then(function (results) {
        const fromGeoObj = results[0].geoObjects.get(0);
        const toGeoObj = results[1].geoObjects.get(0);

        if (!fromGeoObj || !toGeoObj) {
            setStatus('Город не найден. Проверьте написание.');
            return;
        }

        originGeo = fromGeoObj.geometry.getCoordinates(); // [lat, lon]
        destGeo = toGeoObj.geometry.getCoordinates();
        originName = fromInput;
        destName = toInput;

        // Сбрасываем предыдущие заезды при новом маршруте
        selectedWaypoints = [];
        baseRouteGeoJsonCoords = null;

        // Включаем фильтр по расстоянию от трассы
        document.getElementById('show-all').checked = false;
        document.getElementById('distance-slider-group').style.display = 'block';

        requestRouteAndRedraw();

    }).catch(function () {
        setStatus('Ошибка геокодирования. Попробуйте ещё раз.');
    });
}

/**
 * Строит маршрут через Яндекс API, рисует линию на карте,
 * обновляет боковую панель и перефильтровывает метки заправок.
 */
function requestRouteAndRedraw() {
    if (!originGeo || !destGeo) return;

    setStatus('Прокладываю маршрут…');

    // Собираем точки: старт → промежуточные заправки → финиш
    const routePoints = [
        originGeo,
        ...selectedWaypoints.map(wp => ({ type: 'wayPoint', point: [wp.lat, wp.lon] })),
        destGeo
    ];

    ymaps.route(routePoints).then(function (route) {
        // Удаляем старую линию, если была
        if (routeObj) {
            myMap.geoObjects.remove(routeObj);
        }

        // Собираем точные координаты из всех сегментов пути
        let coords = [];
        route.getPaths().each(function (path) {
            const segments = path.getSegments() || [];
            for (let i = 0; i < segments.length; i++) {
                const c = segments[i].getCoordinates();
                if (c && c.length) {
                    coords = coords.concat(c);
                }
            }
        });

        if (coords.length < 2) {
            setStatus('Маршрут не найден или слишком короткий.');
            return;
        }

        // Рисуем синюю линию маршрута
        routeObj = new ymaps.Polyline(coords, {}, {
            strokeColor: ROUTE_LINE_COLOR,
            strokeWidth: ROUTE_LINE_WIDTH,
            strokeOpacity: ROUTE_LINE_OPACITY
        });
        myMap.geoObjects.add(routeObj);

        // Яндекс даёт [lat, lon] — инвертируем в [lon, lat] для Turf.js
        routeGeoJsonCoords = coords.map(c => [c[1], c[0]]);

        // Первый построенный маршрут (без заездов) сохраняем как эталон сортировки
        if (selectedWaypoints.length === 0) {
            baseRouteGeoJsonCoords = routeGeoJsonCoords;
            myMap.setBounds(routeObj.geometry.getBounds(), {
                checkZoomRange: true,
                zoomMargin: 30
            });
        }

        updateRouteSidebar();
        filterAndRenderStations();
        setStatus('Маршрут готов!');

    }, function (error) {
        console.error('Яндекс маршруты:', error);
        setStatus('Ошибка маршрутизации: ' + error.message);
    });
}


/* ─── 7. Боковая панель (список заездов) ───────────────────── */

/**
 * Перерисовывает список промежуточных заправок в панели
 * и обновляет ссылку кнопки «Поехали».
 */
function updateRouteSidebar() {
    const container = document.getElementById('route-list-container');
    const listEl = document.getElementById('waypoints-list');
    const navBtn = document.getElementById('launch-nav');

    if (!originGeo || !destGeo) {
        container.style.display = 'none';
        return;
    }

    container.style.display = 'block';
    listEl.innerHTML = '';

    // Формируем параметр rtext для Яндекс Навигатора:
    // координаты разделяются ~, порядок: старт → заезды → финиш
    const rtextParts = [`${originGeo[0]},${originGeo[1]}`];

    selectedWaypoints.forEach((wp, index) => {
        rtextParts.push(`${wp.lat},${wp.lon}`);

        const stopEl = document.createElement('div');
        stopEl.className = 'route-stop';
        stopEl.innerHTML = `
            <div class="route-stop-title">${index + 1}. ${wp.name}</div>
            <button class="remove-btn" onclick="removeStation(${index})" title="Удалить">✖</button>
        `;
        listEl.appendChild(stopEl);
    });

    rtextParts.push(`${destGeo[0]},${destGeo[1]}`);

    navBtn.style.display = 'block';
    navBtn.href = `https://yandex.ru/maps/?rtext=${rtextParts.join('~')}`;
}


/* ─── 8. Фильтрация и отрисовка заправок ───────────────────── */

/**
 * Фильтрует allFeatures по расстоянию от маршрута (если нужно)
 * и отображает результат через ObjectManager.
 */
function filterAndRenderStations() {
    const showAll = document.getElementById('show-all').checked;
    const maxDistKm = parseFloat(document.getElementById('distance-slider').value);
    const isRouteActive = Boolean(originGeo && destGeo && routeGeoJsonCoords);

    objectManager.removeAll();

    // Строим объект линии Turf один раз — используем для всех дистанций
    const routeLine = buildTurfRouteLine(showAll, isRouteActive);

    const filtered = allFeatures.filter(feature => {
        const [latS, lonS] = feature.geometry.coordinates;
        const stId = feature.id;
        const isAdded = selectedWaypoints.some(w => w.id == stId);

        // Обновляем балун и иконку перед рендером
        feature.properties.balloonContentBody = buildBalloonHtml(feature, latS, lonS, stId, isRouteActive);
        feature.options = { preset: isAdded ? ICON_STATION_ADDED : ICON_STATION_DEFAULT };

        // Без активного фильтра показываем все заправки
        if (showAll || !routeLine) return true;

        // Считаем расстояние от заправки до линии маршрута
        let distanceKm = Infinity;
        try {
            distanceKm = turf.pointToLineDistance(
                turf.point([lonS, latS]),
                routeLine,
                { units: 'kilometers' }
            );
        } catch (e) {
            console.error(`Turf: ошибка для станции ${stId}:`, e);
        }

        return distanceKm <= maxDistKm;
    });

    objectManager.add(filtered);

    // ObjectManager иногда кэширует старые стили — принудительно обновляем
    filtered.forEach(f => {
        if (f.options) {
            objectManager.objects.setObjectOptions(f.id, f.options);
        }
    });
}

/**
 * Создаёт Turf-линию из routeGeoJsonCoords.
 * Перед созданием удаляет дублирующиеся подряд точки (Turf их не принимает).
 *
 * @param {boolean} showAll       — если true, фильтр отключён, линия не нужна
 * @param {boolean} isRouteActive — маршрут прложен?
 * @returns {turf.Feature<turf.LineString> | null}
 */
function buildTurfRouteLine(showAll, isRouteActive) {
    if (showAll || !isRouteActive || routeGeoJsonCoords.length < 2) {
        return null;
    }

    try {
        // Убираем соседние дубликаты координат
        const uniqueCoords = routeGeoJsonCoords.filter((coord, i, arr) => {
            if (i === 0) return true;
            const prev = arr[i - 1];
            return prev[0] !== coord[0] || prev[1] !== coord[1];
        });

        if (uniqueCoords.length < 2) {
            throw new Error('Недостаточно уникальных точек в маршруте');
        }

        return turf.lineString(uniqueCoords);

    } catch (e) {
        console.error('Turf: ошибка построения линии:', e);
        document.getElementById('status').innerHTML =
            `<span style="color: red;">Ошибка Turf: ${e.message}</span>`;
        return null;
    }
}

/**
 * Генерирует HTML-содержимое балуна для одной заправки.
 *
 * @param {GeoJSON.Feature} feature
 * @param {number}          latS        — широта (Яндекс-формат)
 * @param {number}          lonS        — долгота
 * @param {number}          stId        — ID станции
 * @param {boolean}         isRouteActive
 * @returns {string} HTML
 */
function buildBalloonHtml(feature, latS, lonS, stId, isRouteActive) {
    const singleNavLink = `https://yandex.ru/maps/?rtext=~${latS},${lonS}`;

    let html = `
        <div class="station-header">${feature.properties.nameClean}</div>
        <div class="station-address">${feature.properties.addressClean}</div>
    `;

    if (isRouteActive) {
        const alreadyAdded = selectedWaypoints.some(w => w.id == stId);

        html += alreadyAdded
            ? `<button class="yandex-link-btn" disabled>✓ Добавлена в маршрут</button>`
            : `<button class="yandex-link-btn" onclick="addStationToRoute(${stId})">➕ Заехать сюда по пути</button>`;
    } else {
        html += `<a href="${singleNavLink}" target="_blank" class="yandex-link-btn">Отправиться сюда</a>`;
    }

    return html;
}


/* ─── 9. Публичные функции (вызываются из HTML балунов) ───────
   Должны быть на window, так как onclick-атрибуты
   генерируются динамически в buildBalloonHtml.            */

/**
 * Добавляет заправку в маршрут и пересортировывает список
 * по позиции вдоль базовой трассы.
 *
 * @param {number} stationId
 */
window.addStationToRoute = function (stationId) {
    const station = allFeatures.find(f => f.id == stationId);
    if (!station) return;

    if (selectedWaypoints.some(w => w.id == stationId)) {
        alert('Эта заправка уже добавлена в маршрут!');
        return;
    }

    selectedWaypoints.push({
        id: station.id,
        name: station.properties.nameClean,
        lat: station.geometry.coordinates[0],
        lon: station.geometry.coordinates[1]
    });

    // Сортируем заправки по месту проекции на базовый маршрут,
    // чтобы порядок заездов всегда соответствовал направлению движения
    if (baseRouteGeoJsonCoords && baseRouteGeoJsonCoords.length >= 2) {
        try {
            const baseLine = turf.lineString(baseRouteGeoJsonCoords);

            selectedWaypoints.sort((a, b) => {
                const locA = turf.nearestPointOnLine(
                    baseLine, turf.point([a.lon, a.lat])
                ).properties.location || 0;

                const locB = turf.nearestPointOnLine(
                    baseLine, turf.point([b.lon, b.lat])
                ).properties.location || 0;

                return locA - locB;
            });
        } catch (e) {
            console.error('Ошибка сортировки заправок:', e);
        }
    }

    myMap.balloon.close();
    requestRouteAndRedraw();
};

/**
 * Удаляет промежуточную заправку по индексу в списке.
 * @param {number} index
 */
window.removeStation = function (index) {
    selectedWaypoints.splice(index, 1);
    requestRouteAndRedraw();
};


/* ─── 10. Вспомогательные функции ──────────────────────────── */

/**
 * Устанавливает текст строки статуса под кнопкой «Проложить маршрут».
 * @param {string} text
 */
function setStatus(text) {
    document.getElementById('status').innerText = text;
}
