/**
 * app.js — Логика планировщика АГНКС
 *
 * Зависимости (подключаются в index.html):
 *   - Яндекс Карты API (ymaps)
 *   - Turf.js           (turf)
 *   - stations.json     (загружается через fetch)
 */

/** Начальный центр карты: Вся Россия */
const isMobile = window.innerWidth <= 600;
const MAP_CENTER = isMobile ? [56.52401, 87.318756] : [56.52401, 90.318756];
const MAP_ZOOM = isMobile ? 1.5 : 4;

// Иконки меток
const ICON_STATION_DEFAULT = 'islands#blueIcon';
const ICON_STATION_ADDED = 'islands#redIcon';

// Стиль маршрута
const ROUTE_LINE_COLOR = '#1e98ff';
const ROUTE_LINE_WIDTH = 5;
const ROUTE_LINE_OPACITY = 0.8;

let myMap;
let objectManager;
let routeObj = null;

// База всех заправок
let allFeatures = [];

// Координаты маршрута для Turf.js [lon, lat]
let routeGeoJsonCoords = null;

// Базовый маршрут (для сортировки заездов)
let baseRouteGeoJsonCoords = null;

let originGeo = null;
let destGeo = null;
let originName = '';
let destName = '';

// Остановки пользователя
let selectedWaypoints = [];

ymaps.ready(init);

async function init() {
    myMap = new ymaps.Map('map', {
        center: MAP_CENTER,
        zoom: MAP_ZOOM,
        controls: ['zoomControl', 'fullscreenControl']
    });

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

// Загрузка базы станций
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

    // Нормализация данных станции
    function parseStation(item) {
        const nameClean = stripHtml(item.properties.hintContent || 'АГНКС');
        let addressClean = stripHtml(item.properties.balloonContentBody || '');

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

    function stripHtml(html) {
        const div = document.createElement('div');
        div.innerHTML = html;
        return div.textContent || div.innerText || '';
    }
}

function bindUIEvents() {
    const showAllCheckbox = document.getElementById('show-all');
    const distanceSlider = document.getElementById('distance-slider');
    const distanceValLabel = document.getElementById('distance-val');
    const sliderGroup = document.getElementById('distance-slider-group');

    showAllCheckbox.addEventListener('change', function (e) {
        sliderGroup.style.display = e.target.checked ? 'none' : 'block';
        filterAndRenderStations();
    });

    distanceSlider.addEventListener('input', function (e) {
        distanceValLabel.innerText = e.target.value;
    });

    distanceSlider.addEventListener('change', function () {
        filterAndRenderStations();
    });

    document.getElementById('build-route').addEventListener('click', onBuildRouteClick);

    document.getElementById('my-loc-from').addEventListener('click', () => useMyLocation('route-from'));
    document.getElementById('my-loc-to').addEventListener('click', () => useMyLocation('route-to'));
}

function onBuildRouteClick() {
    const fromInput = document.getElementById('route-from').value.trim();
    const toInput = document.getElementById('route-to').value.trim();

    if (!fromInput || !toInput) {
        alert('Заполните поля «Откуда» и «Куда»');
        return;
    }

    setStatus('Геокодирование адресов...');

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

    }).catch(function (error) {
        console.error('Ошибка геокодирования:', error);
        setStatus('Ошибка геокодирования. Возможно, не указан или неверен API-ключ Яндекса.');
    });
}

// Построение маршрута
function requestRouteAndRedraw() {
    if (!originGeo || !destGeo) return;

    setStatus('Прокладываю маршрут…');

    const routePoints = [
        originGeo,
        ...selectedWaypoints.map(wp => ({ type: 'wayPoint', point: [wp.lat, wp.lon] })),
        destGeo
    ];

    ymaps.route(routePoints).then(function (route) {
        if (routeObj) {
            myMap.geoObjects.remove(routeObj);
        }

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

        routeObj = new ymaps.Polyline(coords, {}, {
            strokeColor: ROUTE_LINE_COLOR,
            strokeWidth: ROUTE_LINE_WIDTH,
            strokeOpacity: ROUTE_LINE_OPACITY
        });
        myMap.geoObjects.add(routeObj);

        // Инверсия координат для Turf.js: [lat, lon] -> [lon, lat]
        routeGeoJsonCoords = coords.map(c => [c[1], c[0]]);

        // Сохранение базового маршрута (эталон для сортировки)
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
        setStatus('Ошибка маршрутизации (возможно нет API-ключа Яндекса): ' + error.message);
    });
}

// Обновление боковой панели
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

// Фильтрация и рендер заправок
function filterAndRenderStations() {
    const showAll = document.getElementById('show-all').checked;
    const maxDistKm = parseFloat(document.getElementById('distance-slider').value);
    const isRouteActive = Boolean(originGeo && destGeo && routeGeoJsonCoords);

    objectManager.removeAll();

    const routeLine = buildTurfRouteLine(showAll, isRouteActive);

    const filtered = allFeatures.filter(feature => {
        const [latS, lonS] = feature.geometry.coordinates;
        const stId = feature.id;
        const isAdded = selectedWaypoints.some(w => w.id == stId);

        feature.properties.balloonContentBody = buildBalloonHtml(feature, latS, lonS, stId, isRouteActive);
        feature.options = { preset: isAdded ? ICON_STATION_ADDED : ICON_STATION_DEFAULT };

        if (showAll || !routeLine) return true;

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

    filtered.forEach(f => {
        if (f.options) {
            objectManager.objects.setObjectOptions(f.id, f.options);
        }
    });
}

// Создание Turf-линии маршрута
function buildTurfRouteLine(showAll, isRouteActive) {
    if (showAll || !isRouteActive || routeGeoJsonCoords.length < 2) {
        return null;
    }

    try {
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

// Разметка балуна
function buildBalloonHtml(feature, latS, lonS, stId, isRouteActive) {
    const singleNavLink = `https://yandex.ru/maps/?rtext=~${latS},${lonS}`;
    const placeLink = `https://yandex.ru/maps/?text=${latS},${lonS}`;

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

    html += `<button class="yandex-link-btn" onclick="window.open('${placeLink}', '_blank')" style="margin-top: 10px; background-color: #f5f5f5; color: #333; border: 1px solid #ccc;">Посмотреть на Яндекс Картах</button>`;

    return html;
}

// Добавление остановки
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

    // Сортировка по порядку на маршруте
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

// Удаление остановки
window.removeStation = function (index) {
    selectedWaypoints.splice(index, 1);
    requestRouteAndRedraw();
};

// Определение геолокации
function useMyLocation(inputId) {
    if (!navigator.geolocation) {
        alert('Геолокация не поддерживается вашим браузером');
        return;
    }

    setStatus('Определение местоположения...');
    navigator.geolocation.getCurrentPosition(
        function (position) {
            const lat = position.coords.latitude;
            const lon = position.coords.longitude;

            ymaps.geocode([lat, lon]).then(function (res) {
                const firstGeoObject = res.geoObjects.get(0);
                const address = firstGeoObject ? firstGeoObject.getAddressLine() : `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
                document.getElementById(inputId).value = address;
                setStatus('Местоположение определено');
            }).catch(function () {
                document.getElementById(inputId).value = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
                setStatus('Местоположение определено (без адреса)');
            });
        },
        function (error) {
            setStatus('');
            alert('Не удалось определить местоположение. Проверьте разрешения в браузере.');
        }
    );
}

function setStatus(text) {
    document.getElementById('status').innerText = text;
}
