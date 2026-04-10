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
const ICON_STATION_DEFAULT = 'islands#blueDotIcon';
const ICON_STATION_ADDED = 'islands#yellowDotIcon';

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
let supabaseClient = null;

// Инициализация Supabase (если указаны ключи в config.js)
if (CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY) {
    try {
        // Используем глобальный объект supabase из подключенного SDK
        supabaseClient = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
        console.log('Supabase initialized');
    } catch (e) {
        console.error('Failed to init Supabase:', e);
    }
}

ymaps.ready(init);

async function init() {
    myMap = new ymaps.Map('map', {
        center: MAP_CENTER,
        zoom: MAP_ZOOM,
        controls: isMobile ? [] : ['zoomControl', 'fullscreenControl']
    }, {
        balloonAutoPan: true,
        balloonAutoPanMargin: 20
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

    // Подсказки при вводе адресов
    initCustomSuggest('city-search');
    initCustomSuggest('route-from');
    initCustomSuggest('route-to');

    initBottomSheetResize();
    bindUIEvents();
}

// Загрузка базы станций
async function loadStations() {
    setStatus('Загрузка базы станций…');

    let gazpromData = [], allData = [];
    try {
        // Пробуем загрузить актуальные данные через прокси
        let resGazprom = await fetch('api/gazprom_stations').catch(() => null);

        // Если прокси не ответил
        if (!resGazprom || !resGazprom.ok) {
            console.warn('Dynamic Gazprom API failed, falling back to static file');
            resGazprom = await fetch(`gazprom_stations.json?t=${Date.now()}`).catch(() => null);
        }

        const resAll = await fetch('stations.json').catch(() => null);

        if (resGazprom && resGazprom.ok) {
            try { gazpromData = await resGazprom.json(); } catch (e) { }
        }
        if (resAll && resAll.ok) {
            try { allData = await resAll.json(); } catch (e) { }
        }
    } catch (err) {
        console.error('Ошибка загрузки станций:', err);
    }

    const itemsGazprom = gazpromData && gazpromData.elements ? gazpromData.elements : (Array.isArray(gazpromData) ? gazpromData : []);
    const itemsAll = Array.isArray(allData) ? allData : [];
    console.log(`[Stations] Loaded ${itemsGazprom.length} Gazprom, ${itemsAll.length} primary.`);

    const tolerance = 0.01;
    const processedPosIds = new Set();
    const processedNames = new Map(); // name -> [lat, lon] for fuzzy proximity

    function extractPosId(name) {
        if (!name) return null;
        const match = name.match(/POS-(\d+)/i);
        return match ? match[1] : null;
    }

    function normalizeName(name) {
        if (!name) return '';
        return name.toLowerCase()
            .replace(/^(?:р\.п\.|г\.|с\.|п\.|ст\.|дер\.)\s+/g, '')
            .replace(/[^а-яё0-9]/g, '');
    }

    // 1. Сначала парсим заправки Газпрома (Приоритет 1)
    itemsGazprom.forEach(function (item) {
        if (item.gps) {
            const parsed = parseGazpromStation(item);
            if (parsed) {
                allFeatures.push(parsed);
                const posId = extractPosId(parsed.properties.nameClean);
                if (posId) processedPosIds.add(posId);
                processedNames.set(normalizeName(parsed.properties.nameClean), parsed.geometry.coordinates);
            }
        }
    });


    // 3. Затем парсим общую базу stations.json (Приоритет 3)
    itemsAll.forEach(function (item) {
        if (item.type === 'Feature' && item.geometry && item.properties) {
            const parsed = parseStation(item);
            if (!parsed) return;

            const name = parsed.properties.nameClean;
            const posId = extractPosId(name);
            if (posId && processedPosIds.has(posId)) return;

            const normName = normalizeName(name);
            const [latNew, lonNew] = parsed.geometry.coordinates;

            if (processedNames.has(normName)) {
                const [latE, lonE] = processedNames.get(normName);
                if (Math.abs(latE - latNew) < 0.1 && Math.abs(lonE - lonNew) < 0.1) return;
            }

            const isDuplicate = allFeatures.some(existing => {
                const [latE, lonE] = existing.geometry.coordinates;
                return Math.abs(latE - latNew) < tolerance && Math.abs(lonE - lonNew) < tolerance;
            });

            if (!isDuplicate) {
                allFeatures.push(parsed);
                if (posId) processedPosIds.add(posId);
                processedNames.set(normName, [latNew, lonNew]);
            }
        }
    });

    setStatus('');
    filterAndRenderStations();

    // Парсинг "сырых" данных Газпрома
    function parseGazpromStation(el) {
        const coords = el.gps.split(',').map(s => parseFloat(s.trim()));
        if (!coords || coords.length !== 2 || isNaN(coords[0]) || !coords[0]) return null;

        // Фильтруем строящиеся/планируемые
        const nameClean = stripHtml(el.name || 'АГНКС');
        const constructionKeywords = /строит|стройк|планир|проектир|подготов|не\s*введен/i;
        const addressRaw = el.address || '';
        const scheduleRaw = el.schedule || '';
        if (constructionKeywords.test(nameClean) || constructionKeywords.test(addressRaw) || constructionKeywords.test(scheduleRaw)) {
            return null;
        }

        const nameFinal = nameClean.replace(/^Временно не работает \((.+)\)$/, '$1');
        const addressClean = stripHtml((el.address || '').replace(/^Временно не работает \((.+)\)$/, '$1'));
        const scheduleClean = el.schedule || '';
        const isClosed = scheduleClean === 'Временно не работает';

        return {
            type: 'Feature',
            id: 'gazprom_' + el.id,
            geometry: {
                type: 'Point',
                coordinates: coords
            },
            properties: {
                nameClean: nameFinal,
                addressClean,
                scheduleClean,
                isClosed,
                closeStatus: el.close, // Сохраняем поле close ("1" - ок, "0" - закрыто)
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
                },
                updatedAt: el.updated_at
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

        const lines = bodyClean.split('\n')
            .map(s => s.replace(/^(?:адрес|режим\s*(?:работы|раб)|тел(?:ефон)?|факс|т)\s*[:.-]?\s*/iu, '').trim())
            .filter(Boolean);

        const phoneRegex = /(?:\+7|8\s*[\(\-]?\d{3}|\bтел\.?|\bт\.\s*\(|\bфакс\b|\b8\s*\(\d{3,5}\))/i;
        const permitRegex = /по\s*пропускам|пропускной\s*режим|спецпропуск|сотрудников\s*комбината|по\s*договору|только\s*для\s*юрлиц|только\s*служебн[а-я]*/i;
        const scheduleRegex = /\b\d{1,2}[:.][0-5]\d\b|\d{1,2}ч\d{2}м|ежедневн|будни|круглосуточно|(?<=[^а-яёА-ЯЁa-zA-Z0-9]|^)(пн|вт|ср|чт|пт|сб|вс|будни|выходн)(?=[^а-яёА-ЯЁa-zA-Z0-9]|$)|(?<=[^а-яёА-ЯЁa-zA-Z0-9]|^)(?:с|до)\s+\d{1,2}|суббот|воскрес|выходн|перерыв|режим работы|режим раб|принима|без перерыв|временно не работает|закрыт/iu;

        // Фильтруем строящиеся/планируемые (проверяем все поля)
        const headerRaw = item.properties.balloonContentHeader || '';
        const hintRaw = item.properties.hintContent || '';
        const constructionKeywords = /строит|стройк|планир|проектир|подготов|не\s*введен/i;

        if (constructionKeywords.test(hintRaw) || constructionKeywords.test(headerRaw) || constructionKeywords.test(rawBody)) {
            return null;
        }

        const addressLines = [], scheduleLines = [], phoneLines = [];

        for (const line of lines) {
            if (permitRegex.test(line)) {
                // Если в строке с пропуском есть еще и часы работы, попробуем разделить
                if (scheduleRegex.test(line) && line.includes('.')) {
                    const parts = line.split(/[\.]\s+/);
                    parts.forEach(p => {
                        if (permitRegex.test(p)) addressLines.push(p);
                        else if (scheduleRegex.test(p)) scheduleLines.push(p);
                        else addressLines.push(p);
                    });
                } else {
                    addressLines.push(line);
                }
            } else if (phoneRegex.test(line)) {
                phoneLines.push(line);
            } else if (scheduleRegex.test(line)) {
                scheduleLines.push(line);
            } else {
                addressLines.push(line);
            }
        }

        return {
            type: 'Feature',
            id: 'main_' + item.id,
            geometry: {
                type: 'Point',
                coordinates: item.geometry.coordinates
            },
            properties: {
                nameClean,
                addressClean: addressLines.join(', '),
                scheduleClean: scheduleLines.join('; ') || null,
                phoneClean: phoneLines.join('; ') || null,
                amenities: {
                    around_the_clock: /круглосуточно|24\/7/i.test(scheduleLines.join('; '))
                },
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
    document.getElementById('reset-route').addEventListener('click', resetRoute);
    document.getElementById('btn-city-search').addEventListener('click', onCitySearchClick);

    // Поиск при нажатии Enter в поле города
    document.getElementById('city-search').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') onCitySearchClick();
    });

    document.getElementById('my-loc-city').addEventListener('click', () => useMyLocation('city-search'));
    document.getElementById('my-loc-from').addEventListener('click', () => useMyLocation('route-from'));
    document.getElementById('my-loc-to').addEventListener('click', () => useMyLocation('route-to'));

    // Кнопка смены мест А и Б
    document.getElementById('swap-locations').addEventListener('click', () => {
        const fromInput = document.getElementById('route-from');
        const toInput = document.getElementById('route-to');

        // Меняем текст в инпутах
        const tempVal = fromInput.value;
        fromInput.value = toInput.value;
        toInput.value = tempVal;

        // Меняем глобальные переменные координат
        const tempGeo = originGeo;
        originGeo = destGeo;
        destGeo = tempGeo;

        // Меняем сохраненные названия
        const tempName = originName;
        originName = destName;
        destName = tempName;

        // Если оба пункта заданы — перестраиваем маршрут
        if (originGeo && destGeo) {
            buildRoute(originGeo, destGeo);
        }
    });

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
    const guideList = document.getElementById('guide-list');

    if (guideBtn && guideModal && closeGuideBtn) {
        // Клик по кнопке — показать окно
        guideBtn.addEventListener('click', () => {
            guideModal.style.display = 'flex';
            if (guideList && guideList.children.length === 0) {
                loadGuide();
            }
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

    // === Sidebar Mobile Toggle ===
    const sidebarToggle = document.getElementById('sidebar-toggle');
    const sidebarOverlay = document.getElementById('sidebar-overlay');
    const controls = document.getElementById('controls');

    function toggleSidebar() {
        const isOpen = controls.classList.contains('sidebar-open');
        if (isOpen) {
            controls.classList.remove('sidebar-open');
            sidebarToggle.classList.remove('sidebar-open');
            sidebarOverlay.classList.remove('active');
        } else {
            controls.classList.add('sidebar-open');
            sidebarToggle.classList.add('sidebar-open');
            sidebarOverlay.classList.add('active');
        }
    }

    if (sidebarToggle && sidebarOverlay) {
        sidebarToggle.addEventListener('click', toggleSidebar);
        sidebarOverlay.addEventListener('click', toggleSidebar);
    }

    // Сохраняем ссылки для доступа из других функций
    window.closeSidebar = () => {
        controls.classList.remove('sidebar-open');
        sidebarToggle.classList.remove('sidebar-open');
        sidebarOverlay.classList.remove('active');
    };
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
        setStatus('Укажите оба пункта (Откуда и Куда)');
        return;
    }

    // Если пользователь нажал проложить маршрут, а заполнено только поле Откуда — 
    // возможно он просто хочет найти этот город, если поле Куда пустое.
    // Но мы добавили отдельный поиск, так что просто просим оба поля.

    onBuildRoute(fromInput, toInput);
}

/** Поиск и переход к городу */
async function onCitySearchClick() {
    const cityInput = document.getElementById('city-search');
    const query = cityInput.value.trim();
    if (!query) {
        setStatus('Введите название города');
        return;
    }

    setStatus('Поиск города…');
    try {
        const res = await ymaps.geocode(query, { results: 1 });
        const obj = res.geoObjects.get(0);
        if (obj) {
            const coords = obj.geometry.getCoordinates();
            myMap.setCenter(coords, 10);
            setStatus(`Карта центрирована на: ${query}`);

            // Если была проложена подсказка — убираем её
            if (typeof hideSuggestions === 'function') hideSuggestions();
        } else {
            setStatus('Город не найден');
        }
    } catch (e) {
        console.error('Geocode error:', e);
        setStatus('Ошибка при поиске города');
    }
}

function onBuildRoute(fromInput, toInput) {
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

        if (window.innerWidth <= 600 && window.closeSidebar) {
            window.closeSidebar();
        }

        requestRouteAndRedraw();
        document.getElementById('reset-route').style.display = 'block';

    }).catch(function (error) {
        console.error('Ошибка геокодирования:', error);
        setStatus('Ошибка геокодирования. Возможно, не указан или неверен API-ключ Яндекса.');
    });
}

// Сброс маршрута
function resetRoute() {
    originGeo = null;
    destGeo = null;
    originName = '';
    destName = '';
    selectedWaypoints = [];
    routeGeoJsonCoords = null;
    baseRouteGeoJsonCoords = null;

    if (routeObj) {
        myMap.geoObjects.remove(routeObj);
        routeObj = null;
    }

    document.getElementById('route-from').value = '';
    document.getElementById('route-to').value = '';
    document.getElementById('status').innerText = '';
    document.getElementById('reset-route').style.display = 'none';

    updateRouteSidebar();
    filterAndRenderStations();
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
                zoomMargin: isMobile ? [10, 10, 40, 10] : 30
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

        // Определяем временной статус
        const timeStatus = getStationStatus(feature);
        feature.properties.timeStatus = timeStatus;

        feature.properties.balloonContentBody = buildBalloonHtml(feature, latS, lonS, stId, isRouteActive);

        // Иконки в зависимости от статуса
        let preset = ICON_STATION_DEFAULT;
        if (isAdded) {
            preset = ICON_STATION_ADDED;
        } else if (timeStatus === 'vremenno') {
            preset = 'islands#redDotIcon';
        } else if (timeStatus === 'permit') {
            preset = 'islands#blackDotIcon';
        } else if (timeStatus === 'break') {
            preset = 'islands#orangeDotIcon';
        } else if (timeStatus === 'closed') {
            preset = 'islands#grayDotIcon';
        } else if (timeStatus === 'open') {
            preset = 'islands#greenDotIcon';
        } else if (timeStatus === 'always') {
            preset = 'islands#darkGreenDotIcon';
        } else if (timeStatus === 'no_data') {
            preset = 'islands#blueDotIcon';
        }

        feature.options = { preset };

        if (showAll || !routeLine) {
            // Только фильтр по удобствам
            return amenityFilter.length === 0 || passesAmenityFilter(feature, amenityFilter, timeStatus);
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
            && (amenityFilter.length === 0 || passesAmenityFilter(feature, amenityFilter, timeStatus));
    });

    objectManager.add(filtered);

    filtered.forEach(f => {
        if (f.options) {
            objectManager.objects.setObjectOptions(f.id, f.options);
        }
    });
}

// Проверяет, соответствует ли заправка фильтрам по удобствам
function passesAmenityFilter(feature, amenities, timeStatus) {
    const am = feature.properties.amenities;
    if (!am) return false; // нет данных об удобствах — не подходит
    return amenities.every(key => {
        if (key === 'is_open_now') {
            return timeStatus === 'open' || timeStatus === 'always';
        }
        if (key === 'around_the_clock') {
            return timeStatus === 'always';
        }
        return am[key];
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

/** Определение оффсета по названию региона (из данных Газпрома) */
function getOffsetByRegion(regionName) {
    if (!regionName) return null;
    const r = regionName.toLowerCase();

    // UTC+2
    if (r.includes('калининград')) return 2;

    // UTC+4
    if (r.includes('астрахан') || r.includes('самар') || r.includes('саратов') ||
        r.includes('удмурт') || r.includes('ульянов')) return 4;

    // UTC+5
    if (r.includes('башкортостан') || r.includes('курган') || r.includes('оренбург') ||
        r.includes('перм') || r.includes('свердлов') || r.includes('тюмен') ||
        r.includes('ханты') || r.includes('челябин') || r.includes('ямало')) return 5;

    // UTC+6
    if (r.includes('омск')) return 6;

    // UTC+7
    if (r.includes('алтай') || r.includes('кемеров') || r.includes('краснояр') ||
        r.includes('новосибирск') || r.includes('томск') || r.includes('тыва') || r.includes('хакас')) return 7;

    // UTC+8
    if (r.includes('бурят') || r.includes('иркут')) return 8;

    // UTC+9
    if (r.includes('амурск') || r.includes('забайкаль')) return 9;

    // UTC+10
    if (r.includes('еврейск') || r.includes('приморск') || r.includes('хабаровск')) return 10;

    // UTC+11
    if (r.includes('магадан') || r.includes('сахалин')) return 11;

    // UTC+12
    if (r.includes('камчат') || r.includes('чукот')) return 12;

    // Якутия (3 пояса, оставляем догадку по долготе дальше или берем средний +9)
    if (r.includes('якутия') || r.includes('саха')) return null;

    // По умолчанию для европейской части (если не попало в спец. списки)
    const mskZones = ['москв', 'петербург', 'адыге', 'архангельск', 'белгород', 'брянск', 'владимир',
        'волгоград', 'вологод', 'воронеж', 'дагестан', 'иванов', 'ингушет', 'кабардино', 'калмыки',
        'калуж', 'карели', 'киров', 'коми', 'костром', 'краснодар', 'курск', 'липецк', 'марий',
        'мордови', 'мурманск', 'ненец', 'нижегород', 'новгород', 'орлов', 'пензен', 'псков',
        'ростов', 'рязан', 'смолен', 'ставрополь', 'тамбов', 'татарстан', 'твер', 'тульск',
        'чечн', 'чуваш', 'ярослав'];

    if (mskZones.some(z => r.includes(z))) return 3;

    return null;
}

/** Более точная оценка часового пояса (UTC offset) по долготе для России (как fallback) */
function getRussiaTimeOffset(lon) {
    if (lon < 22.5) return 2;   // Калининград
    if (lon < 45.0) return 3;   // Москва
    if (lon < 53.0) return 4;   // Самара
    if (lon < 69.5) return 5;   // Екатеринбург
    if (lon < 82.5) return 6;   // Омск
    if (lon < 97.5) return 7;   // Красноярск
    if (lon < 112.5) return 8;  // Иркутск
    if (lon < 127.5) return 9;  // Якутск
    if (lon < 140.0) return 10; // Владивосток
    if (lon < 155.0) return 11; // Магадан
    return 12;                  // Камчатка
}

/** Определение текущего рабочего статуса заправки */
function getStationStatus(feature) {
    const p = feature.properties;

    const isVremenno = (p.nameClean && p.nameClean.includes('Временно не работает')) ||
        (p.addressClean && p.addressClean.includes('Временно не работает')) ||
        (p.scheduleClean && p.scheduleClean.includes('Временно не работает')) ||
        p.isClosed;

    if (isVremenno) return 'vremenno';

    // "По пропускам" / Только служебные
    const permitRegex = /по\s*пропускам|пропускной\s*режим|спецпропуск|сотрудников\s*комбината|по\s*договору|служебн[а-я]*\s*транспорт[а-я]*|только\s*для\s*юрлиц|только\s*служебн[а-я]*/i;
    const isPermit = (p.nameClean && permitRegex.test(p.nameClean)) ||
        (p.addressClean && permitRegex.test(p.addressClean)) ||
        (p.scheduleClean && permitRegex.test(p.scheduleClean));

    if (isPermit) return 'permit';

    const lat = feature.geometry.coordinates[0];
    const lon = feature.geometry.coordinates[1];

    // Пытаемся получить оффсет по региону
    let offset = getOffsetByRegion(p.region);

    // Если по региону не вышло (обычная заправка), используем улучшенную долготу
    if (offset === null) {
        offset = getRussiaTimeOffset(lon);
    }

    const now = new Date();
    const utcDate = new Date(now.getTime());
    const stationTime = new Date(utcDate.getTime() + (offset * 3600000));
    const dayToday = stationTime.getUTCDay(); // 0 - вс, 1 - пн
    const absMins = (stationTime.getUTCHours() * 60) + stationTime.getUTCMinutes();

    let schedule = p.scheduleClean ? p.scheduleClean.toLowerCase() : '';
    if (!schedule) return 'no_data';

    // Проверяем круглосуточность ДО нормализации, т.к. «24ч» потом превратится в «24:00»
    const isAlways = /круглосуточно|24\s*\/?\s*7|24\s*[чh]/i.test(schedule);

    // Нормализация дней недели
    schedule = schedule
        .replace(/без\s+выходных?/gi, 'ежедневно')
        .replace(/понедельник[а-я]*/g, 'пн')
        .replace(/вторник[а-я]*/g, 'вт')
        .replace(/сред[ауы][а-я]*/g, 'ср')
        .replace(/четверг[а-я]*/g, 'чт')
        .replace(/пятниц[ауы][а-я]*/g, 'пт')
        .replace(/суббот[ауы][а-я]*/g, 'сб')
        .replace(/воскресень[ея][а-я]*/g, 'вс')
        .replace(/(?:по\s*)?рабочи(?:м|е)\s*дн(?:ям|и)/g, 'будни')
        .replace(/будни[ех]?/g, 'будни')
        .replace(/выходны[ех]/g, 'выходн')
        .replace(/(\d{1,2})\s*утра/gi, '$1:00') // 6 утра -> 6:00
        .replace(/(\d{1,2})(?::(\d{2}))?\s*вечера/gi, (match, h, m) => {
            let hour = parseInt(h);
            const min = m || '00';
            if (hour < 12) hour += 12;
            return hour + ':' + min;
        }) // 9 вечера -> 21:00
        .replace(/(\d{1,2})\s*-\s*(\d{1,2})\s*ч/gi, '$1:00-$2:00') // 8-20ч -> 8:00-20:00
        .replace(/(\d{1,2})\s*ч(?!\d)/gi, '$1:00') // 20ч -> 20:00 (избегаем поломки 5ч30м)
        .replace(/\s+и\s+до\b/gi, '-');

    const segments = schedule.split(/[;\n]\s*/);

    let workingIntervals = [];
    let breakIntervals = [];
    let explicitlyClosedToday = false;
    let hasAnyWorkDayData = false;

    const dayMap = {
        'пн': 1, 'вт': 2, 'ср': 3, 'чт': 4, 'пт': 5, 'сб': 6, 'вс': 0,
        'будни': [1, 2, 3, 4, 5], 'выходн': [6, 0], 'ежедневно': [0, 1, 2, 3, 4, 5, 6]
    };

    segments.forEach(seg => {
        if (!seg.trim()) return;

        let segDays = [];
        let hasDayMarker = false;

        // Диапазоны дней (пн-вс) - поддержка разных тире: -, —, –, −
        const rangeMatches = seg.matchAll(/(пн|вт|ср|чт|пт|сб|вс)\s*(?:-|—|–|−)\s*(пн|вт|ср|чт|пт|сб|вс)/g);
        for (const m of rangeMatches) {
            hasDayMarker = true;
            let start = dayMap[m[1]];
            let end = dayMap[m[2]];
            let s = start === 0 ? 7 : start;
            let e = end === 0 ? 7 : end;
            if (s > e) [s, e] = [e, s];
            for (let i = s; i <= e; i++) segDays.push(i % 7);
        }

        // Отдельные дни и группы (без lookbehind для совместимости)
        const dayTokens = seg.match(/[а-яё]+/g);
        if (dayTokens) {
            dayTokens.forEach(val => {
                if (dayMap[val] !== undefined) {
                    hasDayMarker = true;
                    const d = dayMap[val];
                    if (Array.isArray(d)) segDays.push(...d);
                    else segDays.push(d);
                }
            });
        }

        // Очистка от невидимых символов
        const cleanSeg = seg.replace(/[\u00A0\u200B\u200E\u200F\uFEFF]/g, ' ').trim();
        if (!cleanSeg) return;

        if (!hasDayMarker) {
            segDays = [0, 1, 2, 3, 4, 5, 6];
            hasDayMarker = true;
        }

        if (segDays.includes(dayToday)) {
            const isBreakTrigger = /перерыв|пересменка/i.test(cleanSeg);
            const isNegative = /(?:без|нет|отсутствуют)\s+(?:тех\.\s*)?(?:перерыв|пересменка)/i.test(cleanSeg);
            const isBreak = isBreakTrigger && !isNegative;
            const isGasSale = cleanSeg.includes('реализация газа');

            const timeRegex = /(?:с\s*)?(\d{1,2})(?:\s*[:.ч]\s*(\d{1,2}))?\s*(?:мин|м)?\s*(?:-|—|–|−|по|до|и)\s*(?:до\s*)?(\d{1,2})(?:\s*[:.ч]\s*(\d{1,2}))?\s*(?:мин|м)?/gi;
            let m;
            let timeFound = false;

            // Глобальный поиск всех временных интервалов: 08:00-20:00, 08.00-20.00, 8 00-20 00, 8-20, «с 8 до 20» и т.д.
            // Группы: 1=startH, 2=startM(:), 3=startM(.), 4=startM(space), 5=endH, 6=endM(:), 7=endM(.), 8=endM(space)
            const simpleRegex = /\b(\d{1,2})(?:[:](\d{2})|[.](\d{2})|[ ]([0-5]\d))?\s*(?:-|—|–|−|\s+(?:до|по)\s+)\s*(\d{1,2})(?:[:](\d{2})|[.](\d{2})|[ ]([0-5]\d))?\b/g;
            let simpleM;
            while ((simpleM = simpleRegex.exec(cleanSeg)) !== null) {
                const sh = parseInt(simpleM[1]);
                const sm = parseInt(simpleM[2] || simpleM[3] || simpleM[4] || '0');
                const eh = parseInt(simpleM[5]);
                const em = parseInt(simpleM[6] || simpleM[7] || simpleM[8] || '0');
                if (sh > 24 || sm > 59 || eh > 24 || em > 59) continue;
                if (sh === eh && sm === em) continue;
                timeFound = true;
                const interval = { start: sh * 60 + sm, end: eh * 60 + em };
                if (isBreak && !isGasSale) breakIntervals.push(interval);
                else { workingIntervals.push(interval); hasAnyWorkDayData = true; }
            }

            if (!timeFound) {
                // Фолбэк: стандартный поиск с буквами «с», «до»
                while ((m = timeRegex.exec(cleanSeg)) !== null) {
                    const startH = parseInt(m[1]);
                    const startM = m[2] ? parseInt(m[2]) : 0;
                    const endH = parseInt(m[3]);
                    const endM = m[4] ? parseInt(m[4]) : 0;
                    if (startH > 24 || startM > 59 || endH > 24 || endM > 59) continue;

                    timeFound = true;
                    const interval = { start: startH * 60 + startM, end: endH * 60 + endM };
                    if (isBreak && !isGasSale) breakIntervals.push(interval);
                    else {
                        workingIntervals.push(interval);
                        hasAnyWorkDayData = true;
                    }
                }
            }

            if (!timeFound && /(?:выходн|не работает|закрыт)/i.test(cleanSeg)) {
                explicitlyClosedToday = true;
                workingIntervals = [];
                breakIntervals = [];
                hasAnyWorkDayData = true;
            }
        } else if (hasDayMarker) {
            hasAnyWorkDayData = true;
        }

    });

    // === DEBUG LOG ===
    const debugId = p.nameClean || 'Station';
    console.log(`[Status] ${debugId} | Raw: ${p.scheduleClean} | Norm: ${schedule} | Work:`, workingIntervals, " | Day:", dayToday, " | Mins:", absMins);
    for (const b of breakIntervals) {
        if (absMins >= b.start && absMins < b.end) return 'break';
    }

    if (workingIntervals.length > 0) {
        for (const w of workingIntervals) {
            if (w.end > w.start) {
                if (absMins >= w.start && absMins < w.end) return 'open';
            } else { // Переход через полночь
                if (absMins >= w.start || absMins < w.end) return 'open';
            }
        }
        return 'closed';
    }

    if (isAlways) return 'always';
    if (explicitlyClosedToday) return 'closed';

    // Если есть данные о рабочих часах в другие дни, значит сегодня закрыто
    if (hasAnyWorkDayData) return 'closed';

    return 'no_data';
}

// Иконки удобств для заправок Газпрома
function buildAmenitiesHtml(am, timeStatus) {
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
    ].filter(item => {
        if (item.key === 'around_the_clock') {
            return timeStatus === 'always';
        }
        return am[item.key];
    });

    if (!items.length) return '';

    return items.map(item =>
        `<span class="amenity-badge" title="${item.label}">${item.icon} ${item.label}</span>`
    ).join('');
}

/** Очистка текста расписания от лишней информации (телефонов, префиксов "газ" и т.д.) */
function cleanScheduleText(text) {
    if (!text) return '';

    // Разделяем на части по точке с запятой или новой строке
    const segments = text.split(/[;\n]/);

    const cleanedSegments = segments.map(seg => {
        let s = seg.trim();
        if (!s) return '';

        // 1. Проверяем, не является ли сегмент просто набором цифр (телефоном) или годом
        const digits = s.replace(/\D/g, '');
        // Если цифр много (7+) и нет признаков времени (двоеточие, " - " или сочетание ч и м) — это шум.
        const isTimePattern = s.includes(':') || s.includes(' - ') || /\d{1,2}ч\d{2}м/i.test(s);
        if (digits.length >= 7 && !isTimePattern) {
            return '';
        }
        // Если сегмент — просто год вида «2021» — игнорируем
        if (/^\s*20\d{2}\s*$/.test(s)) {
            return '';
        }

        // 2. Очищаем от известных префиксов
        s = s.replace(/\b(?:тел|т|факс|газ|реализация газа)\.?\s*[:.\-]?\s*/gi, '')
            .replace(/\(\s*\)/g, '') // Пустые скобки
            .trim();

        // 3. Убираем висячую пунктуацию и лишние пробелы
        s = s.replace(/^[;,\s.\-\)]+|[;,\s.\-\(]+$/g, '').replace(/\s+/g, ' ');

        return s;
    }).filter(s => s.length > 3 || /24\/7|пн|вт|ср|чт|пт|сб|вс/i.test(s));

    return cleanedSegments.join('; ') || text;
}

// Разметка балуна
function buildBalloonHtml(feature, latS, lonS, stId, isRouteActive) {
    const singleNavLink = `https://yandex.ru/maps/?rtext=~${latS},${lonS}`;
    const placeLink = `https://yandex.ru/maps/?text=${latS},${lonS}`;

    const p = feature.properties;
    let html = `<div class="balloon-inner-content">`;
    html += `<div class="station-header">${p.nameClean}</div>`;

    const statusMap = {
        'vremenno': { text: 'Временно не работает', color: '#c62828', icon: '❌' },
        'permit': { text: 'Въезд по пропускам', color: '#424242', icon: '🪪' },
        'break': { text: 'Технический перерыв', color: '#ef6c00', icon: '🛠️' },
        'closed': { text: 'Закрыто сейчас', color: '#757575', icon: '🕒' },
        'open': { text: 'Открыто сейчас', color: '#2e7d32', icon: '🟢' },
        'always': { text: 'Круглосуточно', color: '#1b5e20', icon: '♾️' },
        'no_data': { text: 'Нет данных о режиме работы', color: '#1565c0', icon: '❓' }
    };
    const s = statusMap[p.timeStatus || 'no_data'];
    html += `<div style="color:${s.color}; font-weight:bold; font-size:12px; margin-top:4px;">${s.icon} ${s.text}</div>`;

    let address = p.addressClean || '';
    let schedule = p.scheduleClean || '';
    let phone = p.phoneClean || '';

    const combinedPhoneRegex = /(?:(?:тел\.?|т\.|phone|контакты):?\s*[\d\s\(\)+-]{7,})|(?:\([\d\s]{3,7}\)\s*[\d\s-]{5,12})|(?:\+7[\d\s\(\)-]{10,20})|(?:\b8\s*(?=(?:[\s\(\)-]*\d){10,11}\b)[\d\s\(\)-]{10,22})/gi;

    // Функция для очистки адреса/расписания от найденного телефона и его префиксов
    function cleanField(text, found) {
        if (!text || !found) return text;
        return text.replace(found, '')
            .replace(/[,;\s\.]*(?:тел\.?|т\.|phone|контакты)[:\-]?\s*$/i, '') // Убираем висящий префикс в конце
            .replace(/^[;,\s\.]+|[;,\s\.]+$/g, '') // Убираем мусор по краям
            .trim();
    }

    // Извлекаем все телефоны
    const phonesInAddress = address.match(combinedPhoneRegex) || [];
    phonesInAddress.forEach(found => {
        if (!phone.includes(found)) {
            phone = phone ? phone + '; ' + found : found;
        }
        address = cleanField(address, found);
    });

    const phonesInSchedule = schedule.match(combinedPhoneRegex) || [];
    phonesInSchedule.forEach(found => {
        if (!phone.includes(found)) {
            phone = phone ? phone + '; ' + found : found;
        }
        schedule = cleanField(schedule, found);
    });

    if (p.gazpromUrl !== undefined) {
        // Газпромовская заправка — структурированный формат
        if (address) {
            html += `<div class="station-info-row"><b>Адрес:</b> ${address}</div>`;
        }
        if (phone) {
            html += `<div class="station-info-row"><b>Телефон:</b> ${phone}</div>`;
        }
        if (schedule) {
            const prettySchedule = cleanScheduleText(schedule);
            html += `<div class="station-info-row"><b>Режим работы:</b> ${prettySchedule}</div>`;
        }
        const amenityBadges = buildAmenitiesHtml(p.amenities || {}, p.timeStatus);
        if (amenityBadges) {
            html += `<div class="station-info-row"><b>Удобства:</b></div><div class="amenities-row">${amenityBadges}</div>`;
        }
    } else {
        // Обычная заправка — адрес, расписание, телефон
        if (address) {
            html += `<div class="station-info-row"><b>Адрес:</b> ${address}</div>`;
        }
        if (phone) {
            html += `<div class="station-info-row"><b>Телефон:</b> ${phone}</div>`;
        }

        if (schedule && schedule.length > 3) {
            const prettySchedule = cleanScheduleText(schedule);
            html += `<div class="station-info-row"><b>Режим работы:</b> ${prettySchedule}</div>`;
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
            : `<button class="yandex-link-btn" onclick="addStationToRoute('${stId}')">➕ Заехать сюда по пути</button>`;
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
    </div>`; // Закрываем .balloon-inner-content

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
    const statusEl = document.getElementById('status');
    statusEl.innerText = text;

    // На мобильных прокручиваем к статусу, если он изменился на важный
    if (isMobile && text && text.length > 5) {
        const controls = document.getElementById('controls');
        if (controls) controls.scrollTo({ top: 0, behavior: 'smooth' });
    }
}

async function loadGuide() {
    try {
        const gistUrl = 'https://gist.githubusercontent.com/LutherHutchinson/c0b2f374059577f3139c8e30f84f9ed1/raw/';
        const res = await fetch(gistUrl);
        if (!res.ok) throw new Error(`HTTP error ${res.status}`);
        const text = await res.text();

        const listEl = document.getElementById('guide-list');
        if (listEl) {
            listEl.innerHTML = '';
            const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
            lines.forEach(line => {
                const li = document.createElement('li');
                li.innerHTML = line.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
                listEl.appendChild(li);
            });
        }
    } catch (err) {
        console.error('Ошибка загрузки guide.md:', err);
    }
}

// --- РАБОТА С ОТЗЫВАМИ ---

async function fetchComments() {
    if (!supabaseClient) return;

    try {
        const { data, error } = await supabaseClient
            .from('comments')
            .select('*');

        if (!error && data) {
            userComments = {};
            data.forEach(c => {
                if (!userComments[c.station_id]) userComments[c.station_id] = [];
                userComments[c.station_id].push({
                    text: c.text,
                    date: c.date
                });
            });
            console.log('Comments loaded from Supabase');
        } else if (error) {
            console.warn('Supabase fetch error:', error);
        }
    } catch (e) {
        console.error('Supabase exception:', e);
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

    if (!supabaseClient) {
        alert('Система отзывов не настроена (отсутствуют ключи Supabase).');
        return;
    }

    const now = new Date();
    const dateStr = `${String(now.getDate()).padStart(2, '0')}.${String(now.getMonth() + 1).padStart(2, '0')}.${now.getFullYear()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    try {
        const { error } = await supabaseClient
            .from('comments')
            .insert([{ station_id: String(stationId), text, date: dateStr }]);

        if (!error) {
            input.value = '';
            // Локально обновляем данные для мгновенного отображения
            if (!userComments[stationId]) userComments[stationId] = [];
            userComments[stationId].push({ text, date: dateStr });

            // Перерисовываем список отзывов
            const list = document.getElementById(`comments-list-${stationId}`);
            if (list) list.innerHTML = buildCommentsHtml(stationId);

            // Скрываем форму обратно
            toggleCommentForm(stationId);
            console.log('Comment saved to Supabase');
        } else {
            console.error('Supabase insert error:', error);
            alert('Не удалось отправить отзыв. Проверьте настройки базы данных.');
        }
    } catch (e) {
        console.error('Supabase insert exception:', e);
        alert('Ошибка сети при отправке отзыва.');
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

/** Кастомные подсказки через наш серверный прокси */
function initCustomSuggest(inputId) {
    const input = document.getElementById(inputId);
    if (!input) return;

    // Создаем контейнер для подсказок
    let container = input.parentNode.querySelector('.custom-suggest-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'custom-suggest-container';
        container.style.display = 'none';
        input.parentNode.appendChild(container);
    }

    let timeout;

    input.addEventListener('input', () => {
        clearTimeout(timeout);
        const text = input.value.trim();
        if (text.length < 2) {
            container.style.display = 'none';
            input.classList.remove('input-with-suggestions');
            const btn = input.parentNode.querySelector('.my-loc-btn');
            if (btn) btn.classList.remove('btn-with-suggestions');
            return;
        }

        timeout = setTimeout(() => {
            fetchSuggestions(text, (items) => {
                renderSuggestions(items, input, container);
            });
        }, 300);
    });

    let selectedIndex = -1;

    function updateHighlight(items) {
        items.forEach((item, i) => {
            item.classList.toggle('custom-suggest-item--active', i === selectedIndex);
            if (i === selectedIndex) item.scrollIntoView({ block: 'nearest' });
        });
    }

    // Скрытие при нажатии Enter и навигация стрелками
    input.addEventListener('keydown', (e) => {
        const items = Array.from(container.querySelectorAll('.custom-suggest-item'));
        const isOpen = container.style.display !== 'none';

        if (!isOpen) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
            updateHighlight(items);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selectedIndex = Math.max(selectedIndex - 1, -1);
            updateHighlight(items);
        } else if (e.key === 'Enter') {
            if (selectedIndex >= 0 && items[selectedIndex]) {
                items[selectedIndex].click(); // вставляет текст и закрывает
            } else {
                // просто закрываем без выбора подсказки
                container.style.display = 'none';
                input.classList.remove('input-with-suggestions');
                const btn = input.parentNode.querySelector('.my-loc-btn');
                if (btn) btn.classList.remove('btn-with-suggestions');
            }
            selectedIndex = -1;
        } else if (e.key === 'Escape') {
            container.style.display = 'none';
            input.classList.remove('input-with-suggestions');
            const btn = input.parentNode.querySelector('.my-loc-btn');
            if (btn) btn.classList.remove('btn-with-suggestions');
            selectedIndex = -1;
        }
    });

    // Скрытие при потере фокуса
    document.addEventListener('click', (e) => {
        if (e.target !== input && !container.contains(e.target)) {
            container.style.display = 'none';
            input.classList.remove('input-with-suggestions');
            const btn = input.parentNode.querySelector('.my-loc-btn');
            if (btn) btn.classList.remove('btn-with-suggestions');
        }
    });
}

function fetchSuggestions(text, callback) {
    const apiKey = (typeof CONFIG !== 'undefined' && CONFIG.YANDEX_SUGGEST_API_KEY) || '';
    if (!apiKey) {
        console.warn('YANDEX_SUGGEST_API_KEY не задан в config.js');
        return;
    }

    const url = `https://suggest-maps.yandex.ru/v1/suggest?apikey=${apiKey}&text=${encodeURIComponent(text)}&print_address=1&lang=ru`;

    fetch(url)
        .then(response => response.json())
        .then(data => {
            if (data && data.results) {
                callback(data.results);
            }
        })
        .catch(error => console.error('Error fetching suggestions:', error));
}

function renderSuggestions(items, input, container) {
    container.innerHTML = '';
    if (!items || items.length === 0) {
        container.style.display = 'none';
        return;
    }

    items.slice(0, 5).forEach(item => {
        const div = document.createElement('div');
        div.className = 'custom-suggest-item';

        const title = item.title.text;
        const subtitle = item.subtitle ? item.subtitle.text : '';

        div.innerHTML = `
            <span class="title">${title}</span>
            ${subtitle ? `<span class="subtitle">${subtitle}</span>` : ''}
        `;

        div.addEventListener('click', () => {
            input.value = title;
            container.style.display = 'none';

            // Убираем эффекты "выпадения"
            input.classList.remove('input-with-suggestions');
            const btn = input.parentNode.querySelector('.my-loc-btn');
            if (btn) btn.classList.remove('btn-with-suggestions');

            // На мобильных убираем фокус (скрываем клавиатуру) после выбора
            if (isMobile) input.blur();

            // Мы НЕ диспатчим событие 'input', чтобы не спровоцировать 
            // повторный поиск подсказок для этого же текста.
        });

        container.append(div);
    });

    const rect = input.getBoundingClientRect();
    const parentRect = input.parentNode.getBoundingClientRect();

    // Добавляем классы для эффекта "выпадения"
    input.classList.add('input-with-suggestions');
    const btn = input.parentNode.querySelector('.my-loc-btn') || input.parentNode.querySelector('.search-btn-icon');
    if (btn) btn.classList.add('btn-with-suggestions');

    // Позиционируем относительно .input-wrapper (который position: relative)
    container.style.top = (input.offsetTop + input.offsetHeight) + 'px';
    container.style.left = input.offsetLeft + 'px';
    container.style.width = input.offsetWidth + 'px';

    container.style.display = 'block';
}

/** Регулировка высоты нижней панели (Bottom Sheet) перетаскиванием */
function initBottomSheetResize() {
    const controls = document.getElementById('controls');
    const handle = document.getElementById('bottom-sheet-handle');
    if (!controls || !handle || !isMobile) return;

    let isDragging = false;
    let startY = 0;
    let startHeight = 0;

    // Загружаем сохраненную высоту
    const savedHeight = localStorage.getItem('bottomSheetHeight');
    if (savedHeight) {
        controls.style.height = savedHeight;
    }

    const onStart = (e) => {
        isDragging = true;
        startY = e.type.includes('touch') ? e.touches[0].clientY : e.clientY;
        startHeight = controls.offsetHeight;
        document.body.style.userSelect = 'none'; // Запрет выделения при таще
    };

    const onMove = (e) => {
        if (!isDragging) return;
        const currentY = e.type.includes('touch') ? e.touches[0].clientY : e.clientY;
        const deltaY = startY - currentY;
        const newHeight = startHeight + deltaY;

        // Ограничения (от 48px до 90% экрана)
        const minH = 48;
        const maxH = window.innerHeight * 0.9;

        if (newHeight >= minH && newHeight <= maxH) {
            controls.style.height = `${newHeight}px`;
        }
    };

    const onEnd = () => {
        if (isDragging) {
            isDragging = false;
            document.body.style.userSelect = '';
            // Сохраняем результат
            localStorage.setItem('bottomSheetHeight', controls.style.height);
        }
    };

    handle.addEventListener('mousedown', onStart);
    handle.addEventListener('touchstart', onStart, { passive: false });

    window.addEventListener('mousemove', onMove);
    window.addEventListener('touchmove', onMove, { passive: false });

    window.addEventListener('mouseup', onEnd);
    window.addEventListener('touchend', onEnd);
}
