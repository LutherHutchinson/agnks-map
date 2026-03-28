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
const ICON_STATION_ADDED = 'islands#greenIcon';

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

// Пользовательские отзывы
let userComments = {};

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

    // Сначала загружаем отзывы пользователей
    await fetchComments();

    // Затем загружаем базу заправок (она использует отзывы при сборке балунов)
    await loadStations();

    bindUIEvents();
}

// Загрузка базы станций
async function loadStations() {
    setStatus('Загрузка базы станций…');

    let gazpromData, allData;
    try {
        const [resGazprom, resAll] = await Promise.all([
            fetch('gazprom_stations.json'),
            fetch('stations.json')
        ]);

        if (!resGazprom.ok) throw new Error(`HTTP Gazprom ${resGazprom.status}`);
        if (!resAll.ok) throw new Error(`HTTP All ${resAll.status}`);

        gazpromData = await resGazprom.json();
        allData = await resAll.json();
    } catch (err) {
        setStatus(`Ошибка загрузки баз станций: ${err.message}`);
        return;
    }

    const itemsGazprom = gazpromData.elements ? gazpromData.elements : gazpromData;
    const tolerance = 0.01; // ~1 км погрешности при совпадении координат из разных источников

    // Сначала парсим заправки Газпрома
    itemsGazprom.forEach(function (item) {
        if (item.gps) {
            const parsed = parseGazpromStation(item);
            if (parsed) allFeatures.push(parsed);
        }
    });

    // Затем парсим общую базу, исключая дубликаты
    allData.forEach(function (item) {
        if (item.type === 'Feature' && item.geometry && item.properties) {
            const parsed = parseStation(item);
            if (!parsed) return;

            const [latNew, lonNew] = parsed.geometry.coordinates;
            // Проверяем, нет ли уже газпромовской заправки с такими же координатами
            const isDuplicate = allFeatures.some(existing => {
                const [latE, lonE] = existing.geometry.coordinates;
                return Math.abs(latE - latNew) < tolerance && Math.abs(lonE - lonNew) < tolerance;
            });

            if (!isDuplicate) {
                allFeatures.push(parsed);
            }
        }
    });

    setStatus('');
    filterAndRenderStations();

    // Парсинг "сырых" данных Газпрома
    function parseGazpromStation(el) {
        const coords = el.gps.split(',').map(s => parseFloat(s.trim()));
        if (!coords || coords.length !== 2 || isNaN(coords[0]) || (coords[0] === 0 && coords[1] === 0)) return null;

        const nameClean = stripHtml(el.name || 'АГНКС').replace(/^Временно не работает \((.+)\)$/, '$1');
        const addressClean = stripHtml((el.address || '').replace(/^Временно не работает \((.+)\)$/, '$1'));
        const scheduleClean = el.schedule || '';
        const isClosed = scheduleClean === 'Временно не работает';

        return {
            type: 'Feature',
            id: el.id,
            geometry: {
                type: 'Point',
                coordinates: coords
            },
            properties: {
                nameClean,
                addressClean,
                scheduleClean,
                isClosed,
                clusterCaption: el.city ? `${el.city}, ${nameClean}` : nameClean,
                hintContent: nameClean,
                rawCoords: coords,
                gazpromUrl: el.url,
                amenities: {
                    around_the_clock: !!el.around_the_clock,
                    payment_sce: !!el.payment_sce,
                    payment_bc: !!el.payment_bc,
                    payment_c: !!el.payment_c,
                    cng: !!el.cng,
                    lng: !!el.lng,
                    cafe: !!el.cafe,
                    shop: !!el.shop,
                    wc: !!el.wc,
                    charging: !!el.charging_for_electric_cars,
                    washing: !!el.automatic_washing,
                    tire_inflation: !!el.tire_inflation
                }
            }
        };
    }

    // Нормализация данных стандартной станции
    function parseStation(item) {
        const nameClean = stripHtml(item.properties.hintContent || 'АГНКС');

        // Сохраняем разрывы строк перед strip
        const rawBody = (item.properties.balloonContentBody || '')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/p>/gi, '\n')
            .replace(/подробнее/gi, '');

        const bodyClean = stripHtml(rawBody);

        // Разбиваем на строки и классифицируем
        const lines = bodyClean.split('\n').map(s => s.trim()).filter(Boolean);

        const phoneRegex = /(\+7|8\s*[\(\-]?\d{3}|\бтел\b|факс)/i;
        const scheduleRegex = /\d{1,2}:\d{2}|ежедневн|круглосуточно|пн|вт|ср|чт|пт|сб|вс|суббот|воскрес|выходн|перерыв|режим раб|принима|без перерыв/i;

        const addressLines = [], scheduleLines = [], phoneLines = [];

        for (const line of lines) {
            if (phoneRegex.test(line)) {
                phoneLines.push(line);
            } else if (scheduleRegex.test(line)) {
                scheduleLines.push(line);
            } else {
                addressLines.push(line);
            }
        }

        return {
            type: 'Feature',
            id: item.id,
            geometry: {
                type: 'Point',
                coordinates: item.geometry.coordinates
            },
            properties: {
                nameClean,
                addressClean: addressLines.join(', '),
                scheduleClean: scheduleLines.join('; ') || null,
                phoneClean: phoneLines.join('; ') || null,
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

    // Фильтр по удобствам — кнопка раскрытия
    document.getElementById('amenity-toggle').addEventListener('click', function () {
        const panel = document.getElementById('amenity-filter-panel');
        const arrow = document.getElementById('amenity-toggle-arrow');
        const open = panel.style.display === 'none';
        panel.style.display = open ? 'block' : 'none';
        arrow.textContent = open ? '▾' : '▸';
    });

    // При смене любого чекбокса удобств — перефильтровать
    document.querySelectorAll('[data-amenity]').forEach(cb => {
        cb.addEventListener('change', filterAndRenderStations);
    });

    // Сбросить фильтры
    document.getElementById('reset-amenity-filters').addEventListener('click', function () {
        document.querySelectorAll('[data-amenity]').forEach(cb => { cb.checked = false; });
        filterAndRenderStations();
    });

    // === ДОБАВЛЕНО: Модальное окно инструкции ===
    const guideBtn = document.getElementById('guide-btn');
    const guideModal = document.getElementById('guide-modal');
    const closeGuideBtn = document.getElementById('close-guide');

    if (guideBtn && guideModal && closeGuideBtn) {
        // Клик по кнопке — показать окно
        guideBtn.addEventListener('click', () => {
            guideModal.style.display = 'flex';
        });

        // Клик по крестику — скрыть окно
        closeGuideBtn.addEventListener('click', () => {
            guideModal.style.display = 'none';
        });

        // Закрытие по клику вне белого окна (по серому фону)
        guideModal.addEventListener('click', (e) => {
            if (e.target === guideModal) {
                guideModal.style.display = 'none';
            }
        });
    }
}

// Возвращает список выбранных фильтров по удобствам
function getSelectedAmenities() {
    const selected = [];
    document.querySelectorAll('[data-amenity]:checked').forEach(cb => {
        selected.push(cb.dataset.amenity);
    });
    return selected;
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
    const amenityFilter = getSelectedAmenities();

    objectManager.removeAll();

    const routeLine = buildTurfRouteLine(showAll, isRouteActive);

    const filtered = allFeatures.filter(feature => {
        const [latS, lonS] = feature.geometry.coordinates;
        const stId = feature.id;
        const isAdded = selectedWaypoints.some(w => w.id == stId);

        feature.properties.balloonContentBody = buildBalloonHtml(feature, latS, lonS, stId, isRouteActive);
        const isClosed = feature.properties.isClosed;
        feature.options = {
            preset: isAdded ? ICON_STATION_ADDED
                : isClosed ? 'islands#redDotIcon'
                    : ICON_STATION_DEFAULT
        };

        if (showAll || !routeLine) {
            // Только фильтр по удобствам
            return amenityFilter.length === 0 || passesAmenityFilter(feature, amenityFilter);
        }

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

        return distanceKm <= maxDistKm
            && (amenityFilter.length === 0 || passesAmenityFilter(feature, amenityFilter));
    });

    objectManager.add(filtered);

    filtered.forEach(f => {
        if (f.options) {
            objectManager.objects.setObjectOptions(f.id, f.options);
        }
    });
}

// Проверяет, соответствует ли заправка фильтрам по удобствам
function passesAmenityFilter(feature, amenities) {
    const am = feature.properties.amenities;
    if (!am) return false; // нет данных об удобствах — не подходит
    return amenities.every(key => am[key]);
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

// Иконки удобств для заправок Газпрома
function buildAmenitiesHtml(am) {
    const items = [
        { key: 'around_the_clock', icon: '🕐', label: 'Круглосуточно' },
        { key: 'cng', icon: '🔵', label: 'КПГ' },
        { key: 'lng', icon: '❄️', label: 'СПГ' },
        { key: 'payment_bc', icon: '💳', label: 'Банковские карты' },
        { key: 'payment_c', icon: '💵', label: 'Наличные' },
        { key: 'payment_sce', icon: '🪪', label: 'Карта ECOGAS' },
        { key: 'cafe', icon: '☕', label: 'Кафе' },
        { key: 'shop', icon: '🛍️', label: 'Магазин' },
        { key: 'wc', icon: '🚻', label: 'Туалет' },
        { key: 'charging', icon: '⚡', label: 'Зарядка для электрокаров' },
        { key: 'washing', icon: '🚗', label: 'Автомойка' },
        { key: 'tire_inflation', icon: '🔧', label: 'Подкачка шин' }
    ].filter(item => am[item.key]);

    if (!items.length) return '';

    return items.map(item =>
        `<span class="amenity-badge" title="${item.label}">${item.icon} ${item.label}</span>`
    ).join('');
}

// Разметка балуна
function buildBalloonHtml(feature, latS, lonS, stId, isRouteActive) {
    const singleNavLink = `https://yandex.ru/maps/?rtext=~${latS},${lonS}`;
    const placeLink = `https://yandex.ru/maps/?text=${latS},${lonS}`;

    const p = feature.properties;
    let html = `<div class="station-header">${p.nameClean}</div>`;

    if (p.isClosed) {
        html += `<div style="color:#c62828; font-weight:bold; font-size:12px; margin-top:4px;">❌ Временно не работает</div>`;
    }

    if (p.gazpromUrl !== undefined) {
        // Газпромовская заправка — структурированный формат
        html += `<div class="station-info-row"><b>Адрес:</b> ${p.addressClean}</div>`;
        if (p.scheduleClean) {
            html += `<div class="station-info-row"><b>Режим работы:</b> ${p.scheduleClean}</div>`;
        }
        const amenityBadges = buildAmenitiesHtml(p.amenities || {});
        if (amenityBadges) {
            html += `<div class="station-info-row"><b>Удобства:</b><div class="amenities-row">${amenityBadges}</div></div>`;
        }
    } else {
        // Обычная заправка — адрес, расписание, телефон
        if (p.addressClean) {
            html += `<div class="station-info-row"><b>Адрес:</b> ${p.addressClean}</div>`;
        }
        if (p.scheduleClean) {
            html += `<div class="station-info-row"><b>Режим работы:</b> ${p.scheduleClean}</div>`;
        }
    }

    // Секция отзывов (только список)
    html += `
        <div class="balloon-comments-wrap">
            <div class="comments-header">💬 Отзывы и инфо:</div>
            <div id="comments-list-${stId}" class="comments-list">
                ${buildCommentsHtml(stId)}
            </div>
        </div>
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

    // Кнопка добавления отзыва в самом низу
    html += `
        <div id="comment-form-wrap-${stId}" style="display: none; margin-top: 10px;">
            <div class="add-comment-form">
                <textarea id="comment-input-${stId}" placeholder="Расскажите подробности о заправке (сломано, очереди, сервис...)" rows="3"></textarea>
                <button onclick="onCommentSubmit('${stId}')" class="comment-send-btn">Отправить информацию</button>
            </div>
        </div>
        <button id="comment-toggle-btn-${stId}" class="comment-toggle-btn" onclick="toggleCommentForm('${stId}')">
            📝 Оставить заметку
        </button>
    `;

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
// --- РАБОТА С ОТЗЫВАМИ ---

async function fetchComments() {
    try {
        const res = await fetch('/api/comments');
        if (res.ok) {
            userComments = await res.json();
        }
    } catch (e) {
        console.error('Ошибка загрузки отзывов:', e);
    }
}

function buildCommentsHtml(stationId) {
    const comments = userComments[stationId] || [];
    if (comments.length === 0) {
        return '<div class="no-comments">Пока нет отзывов. Будьте первым!</div>';
    }
    // Копируем и разворачиваем, чтобы самые новые были сверху
    return comments.slice().reverse().map(c => `
        <div class="comment-item">
            <div class="comment-text">${escapeHtml(c.text)}</div>
            <div class="comment-meta">${c.date}</div>
        </div>
    `).join('');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

async function onCommentSubmit(stationId) {
    const input = document.getElementById(`comment-input-${stationId}`);
    const text = input.value.trim();
    if (!text) return;

    try {
        const response = await fetch('/api/comments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stationId, text })
        });

        if (response.ok) {
            input.value = '';
            // Локально обновляем данные для мгновенного отображения
            if (!userComments[stationId]) userComments[stationId] = [];

            const now = new Date();
            const dateStr = `${String(now.getDate()).padStart(2, '0')}.${String(now.getMonth() + 1).padStart(2, '0')}.${now.getFullYear()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

            userComments[stationId].push({ text, date: dateStr });

            // Перерисовываем список отзывов
            const list = document.getElementById(`comments-list-${stationId}`);
            if (list) list.innerHTML = buildCommentsHtml(stationId);

            // Скрываем форму обратно
            toggleCommentForm(stationId);
        } else {
            alert('Не удалось отправить отзыв. Попробуйте позже.');
        }
    } catch (e) {
        console.error('Ошибка отправки отзыва:', e);
        alert('Ошибка сети.');
    }
}

function toggleCommentForm(stationId) {
    const formWrap = document.getElementById(`comment-form-wrap-${stationId}`);
    const toggleBtn = document.getElementById(`comment-toggle-btn-${stationId}`);

    if (formWrap.style.display === 'none') {
        formWrap.style.display = 'block';
        toggleBtn.style.display = 'none';
        // Фокус на поле ввода
        setTimeout(() => {
            const input = document.getElementById(`comment-input-${stationId}`);
            if (input) input.focus();
        }, 100);
    } else {
        formWrap.style.display = 'none';
        toggleBtn.style.display = 'block';
    }
}
