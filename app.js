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

// Сразу проверяем хеш, пока Supabase его не очистила
const isRecoveryFlow = window.location.hash && (window.location.hash.includes('type=recovery') || window.location.hash.includes('recovery'));
if (isRecoveryFlow) console.log('Recovery flow detected at script start');

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
let needsFuelPlanning = false;

let originGeo = null;
let destGeo = null;
let originName = '';
let destName = '';

// Промежуточные города
let userViaPoints = [];

// Остановки пользователя
let selectedWaypoints = [];

// Пользовательские отзывы
let userComments = {};
let supabaseClient = null;
let currentUser = null;
let authMode = 'login'; // 'login', 'register', 'reset-password', or 'update-password'

// Избранное
let favoriteStations = JSON.parse(localStorage.getItem('favStations') || '[]');

// Функция сохранения избранного
function saveFavorites() {
    localStorage.setItem('favStations', JSON.stringify(favoriteStations));
    filterAndRenderStations(); // Перерисовываем карту
}

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
    initAuth();

    // Подписка на реальное время + поллинг-фолбек
    if (supabaseClient) {
        subscribeToComments();
        setInterval(fetchComments, 30000); // Поллинг каждые 30 секунд
    }
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
                    around_the_clock: /круглосуточно|24\/7/i.test(scheduleLines.join('; ')),
                    cng: true // Все заправки из этого файла — метановые
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
    document.getElementById('build-route-fuel').addEventListener('click', onBuildRouteFuelClick);

    // Поиск при нажатии Enter в поле города
    document.getElementById('city-search').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') onCitySearchClick();
    });

    document.getElementById('my-loc-city').addEventListener('click', () => useMyLocation('city-search'));
    document.getElementById('my-loc-from').addEventListener('click', () => useMyLocation('route-from'));
    document.getElementById('my-loc-to').addEventListener('click', () => useMyLocation('route-to'));

    // Добавление промежуточных точек и обновление коннекторов
    let viaPointCount = 0;

    function renderConnectors() {
        document.querySelectorAll('.route-connector-row').forEach(el => el.remove());

        const originWrapper = document.getElementById('origin-wrapper');
        const destWrapper = document.getElementById('dest-wrapper');
        const viaContainer = document.getElementById('via-points-container');

        const createConnector = (topEl, bottomEl, insertIndex) => {
            const row = document.createElement('div');
            row.className = 'route-connector-row';
            row.innerHTML = `
                <button type="button" class="connector-swap-btn" title="Поменять местами">⇅</button>
                <button type="button" class="connector-add-btn" title="Добавить промежуточный город">➕</button>
            `;

            row.querySelector('.connector-swap-btn').addEventListener('click', () => {
                const topInput = topEl.querySelector('input[type="text"]');
                const bottomInput = bottomEl.querySelector('input[type="text"]');

                const tempVal = topInput.value;
                topInput.value = bottomInput.value;
                bottomInput.value = tempVal;
            });

            row.querySelector('.connector-add-btn').addEventListener('click', () => {
                viaPointCount++;
                const wrapper = document.createElement('div');
                wrapper.className = 'via-point-group';
                wrapper.style.display = 'flex';
                wrapper.style.gap = '8px';
                wrapper.style.alignItems = 'stretch';
                wrapper.style.width = '100%';
                wrapper.style.marginBottom = '12px';
                wrapper.style.position = 'relative';

                wrapper.innerHTML = `
                    <input type="text" id="route-via-${viaPointCount}" class="via-point-input" placeholder="Через (промежуточная точка)" style="width: 100%; flex-grow: 1; min-width: 0; margin-bottom: 0;">
                    <button type="button" class="remove-via-btn" title="Удалить точку" style="margin-bottom: 0;">✖</button>
                `;

                const currentVias = viaContainer.querySelectorAll('.via-point-group');
                if (insertIndex < currentVias.length) {
                    viaContainer.insertBefore(wrapper, currentVias[insertIndex]);
                } else {
                    viaContainer.appendChild(wrapper);
                }

                initCustomSuggest(`route-via-${viaPointCount}`);

                wrapper.querySelector('.remove-via-btn').addEventListener('click', () => {
                    viaContainer.removeChild(wrapper);
                    renderConnectors();
                });

                renderConnectors();
            });

            return row;
        };

        const viaGroups = Array.from(viaContainer.children);

        // 1. Between origin and first via/dest
        const firstConnector = createConnector(originWrapper, viaGroups.length ? viaGroups[0] : destWrapper, 0);
        originWrapper.parentNode.insertBefore(firstConnector, originWrapper.nextSibling);

        // 2. Between vias, and between last via and dest
        for (let i = 0; i < viaGroups.length; i++) {
            const nextEl = i === viaGroups.length - 1 ? destWrapper : viaGroups[i + 1];
            const conn = createConnector(viaGroups[i], nextEl, i + 1);
            viaGroups[i].parentNode.insertBefore(conn, viaGroups[i].nextSibling);
        }
    }

    renderConnectors();

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

    // === Auth Events ===
    const authBtn = document.getElementById('auth-btn');
    const authModal = document.getElementById('auth-modal');
    const closeAuthBtn = document.getElementById('close-auth');
    const authForm = document.getElementById('auth-form');
    const authSwitchLink = document.getElementById('auth-switch-link');
    const authForgotLink = document.getElementById('auth-forgot-link');

    if (authBtn) {
        authBtn.addEventListener('click', () => {
            if (currentUser) {
                if (confirm(`Выйти из аккаунта ${currentUser.email}?`)) {
                    logout();
                }
            } else {
                openAuthModal();
            }
        });
    }

    if (closeAuthBtn) {
        closeAuthBtn.addEventListener('click', closeAuthModal);
    }

    if (authSwitchLink) {
        authSwitchLink.addEventListener('click', (e) => {
            e.preventDefault();
            toggleAuthMode();
        });
    }

    if (authForgotLink) {
        authForgotLink.addEventListener('click', (e) => {
            e.preventDefault();
            authMode = 'reset-password';
            updateAuthModalLabels();
        });
    }

    if (authForm) {
        authForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('auth-email').value;
            const password = document.getElementById('auth-password').value;
            const errorEl = document.getElementById('auth-error');
            const successEl = document.getElementById('auth-success');

            errorEl.style.display = 'none';
            successEl.style.display = 'none';

            const submitBtn = document.getElementById('auth-submit-btn');
            const originalText = submitBtn.innerText;
            submitBtn.disabled = true;
            submitBtn.innerText = 'Загрузка...';

            try {
                if (authMode === 'login') {
                    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
                    if (error) throw error;
                } else if (authMode === 'register') {
                    const { error } = await supabaseClient.auth.signUp({ email, password });
                    if (error) throw error;
                    alert('Регистрация успешна!');
                } else if (authMode === 'reset-password') {
                    const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
                        redirectTo: window.location.origin + window.location.pathname
                    });
                    if (error) throw error;
                    successEl.innerText = 'Письмо для сброса пароля отправлено!';
                    successEl.style.display = 'block';
                    authForm.style.display = 'none';
                } else if (authMode === 'update-password') {
                    const { error } = await supabaseClient.auth.updateUser({ password });
                    if (error) throw error;
                    alert('Пароль успешно обновлен!');
                    authMode = 'login';
                    closeAuthModal();
                }
            } catch (err) {
                errorEl.innerText = translateAuthError(err.message);
                errorEl.style.display = 'block';
            } finally {
                submitBtn.disabled = false;
                submitBtn.innerText = originalText;
            }
        });
    }

    // === Favorite Routes Events ===
    const myRoutesBtn = document.getElementById('my-routes-btn');
    if (myRoutesBtn) {
        myRoutesBtn.addEventListener('click', openRoutesModal);
    }
    document.getElementById('close-routes').addEventListener('click', closeRoutesModal);

    const saveRouteBtn = document.getElementById('save-route-btn');
    if (saveRouteBtn) {
        saveRouteBtn.addEventListener('click', openSaveRouteModal);
    }
    document.getElementById('close-save-route').addEventListener('click', closeSaveRouteModal);

    const saveRouteForm = document.getElementById('save-route-form');
    if (saveRouteForm) {
        saveRouteForm.addEventListener('submit', onSaveRouteSubmit);
    }

    // === Report Error Events ===
    const sidebarReportBtn = document.getElementById('sidebar-report-error');
    if (sidebarReportBtn) {
        sidebarReportBtn.addEventListener('click', () => openReportModal());
    }

    const closeReportBtn = document.getElementById('close-report');
    const reportModal = document.getElementById('report-modal');

    if (closeReportBtn) {
        closeReportBtn.addEventListener('click', closeReportModal);
    }

    if (reportModal) {
        reportModal.addEventListener('click', (e) => {
            if (e.target === reportModal) {
                closeReportModal();
            }
        });
    }

    const reportForm = document.getElementById('report-form');
    if (reportForm) {
        reportForm.addEventListener('submit', submitErrorReport);
    }
}

async function onSaveRouteSubmit(e) {
    e.preventDefault();
    const nameInput = document.getElementById('route-name-input');
    const name = nameInput.value.trim();
    if (!name) return;

    await saveCurrentRoute(name);
    nameInput.value = '';
}

// === Auth Functions ===
async function initAuth() {
    if (!supabaseClient) return;

    supabaseClient.auth.onAuthStateChange(async (event, session) => {
        currentUser = session?.user || null;
        updateAuthUI();

        console.log('Auth event:', event, 'authMode:', authMode, 'isRecoveryFlow:', isRecoveryFlow);

        if (event === 'SIGNED_IN') {
            // Если мы в процессе восстановления пароля — НЕ закрываем окно!
            if (authMode === 'update-password' || isRecoveryFlow) {
                authMode = 'update-password';
                updateAuthModalLabels();
            } else {
                closeAuthModal();
            }
            // Синхронизируем избранное при входе
            await syncLocalFavorites();
            await fetchFavorites();
        } else if (event === 'SIGNED_OUT') {
            favoriteStations = JSON.parse(localStorage.getItem('favStations') || '[]');
            filterAndRenderStations();
        } else if (event === 'PASSWORD_RECOVERY') {
            openAuthModal('update-password');
        }
    });

    // Если в URL были признаки восстановления — принудительно открываем форму
    if (isRecoveryFlow) {
        console.log('Forcing open update-password modal');
        openAuthModal('update-password');
    }

    const { data: { session } } = await supabaseClient.auth.getSession();
    currentUser = session?.user || null;
    updateAuthUI();

    if (supabaseClient) {
        await fetchComments();
        subscribeToComments(); // Подписка на новые отзывы
    }

    if (currentUser) {
        await fetchFavorites();
        await fetchSavedRoutes(); // Добавлено
    }
}

async function fetchFavorites() {
    if (!supabaseClient || !currentUser) return;
    try {
        const { data, error } = await supabaseClient
            .from('favorites')
            .select('station_id')
            .eq('user_id', currentUser.id);

        if (error) throw error;

        // Объединяем с локальными или заменяем? Обычно лучше объединить
        const remoteIds = data.map(item => item.station_id);
        const localIds = JSON.parse(localStorage.getItem('favStations') || '[]');

        // Уникальный набор
        const combined = new Set([...localIds, ...remoteIds]);
        favoriteStations = Array.from(combined);
        saveFavorites();
    } catch (err) {
        console.error('Error fetching favorites:', err);
    }
}

async function syncLocalFavorites() {
    if (!supabaseClient || !currentUser) return;
    const localIds = JSON.parse(localStorage.getItem('favStations') || '[]');
    if (localIds.length === 0) return;

    try {
        const toInsert = localIds.map(id => ({
            user_id: currentUser.id,
            station_id: id
        }));

        // Используем upsert чтобы избежать ошибок дубликатов
        const { error } = await supabaseClient
            .from('favorites')
            .upsert(toInsert, { onConflict: 'user_id,station_id' });

        if (error) throw error;
    } catch (err) {
        console.error('Error syncing local favorites:', err);
    }
}

async function syncFavoriteToSupabase(stId) {
    if (!supabaseClient || !currentUser) return;
    try {
        await supabaseClient
            .from('favorites')
            .upsert({ user_id: currentUser.id, station_id: stId }, { onConflict: 'user_id,station_id' });
    } catch (err) {
        console.error('Error adding favorite to Supabase:', err);
    }
}

async function removeFavoriteFromSupabase(stId) {
    if (!supabaseClient || !currentUser) return;
    try {
        await supabaseClient
            .from('favorites')
            .delete()
            .eq('user_id', currentUser.id)
            .eq('station_id', stId);
    } catch (err) {
        console.error('Error removing favorite from Supabase:', err);
    }
}

function updateAuthUI() {
    const authBtn = document.getElementById('auth-btn');
    if (!authBtn) return;

    if (currentUser) {
        const name = currentUser.email.split('@')[0];
        authBtn.innerHTML = `👤 ${name}`;
        authBtn.title = `Вы вошли как ${currentUser.email}. Нажмите, чтобы выйти.`;
    } else {
        authBtn.innerHTML = `👤 Войти`;
        authBtn.title = `Вход / Регистрация`;
    }

    // Состояние кнопки "Мои маршруты" и "Сохранить маршрут"
    const myRoutesBtn = document.getElementById('my-routes-btn');
    if (myRoutesBtn) {
        myRoutesBtn.style.display = currentUser ? 'flex' : 'none';
    }
}

function openAuthModal(mode = 'login') {
    authMode = mode;
    updateAuthModalLabels();
    document.getElementById('auth-modal').style.display = 'flex';
}

function closeAuthModal() {
    document.getElementById('auth-modal').style.display = 'none';
    document.getElementById('auth-error').style.display = 'none';
    document.getElementById('auth-success').style.display = 'none';
    document.getElementById('auth-form').reset();
    document.getElementById('auth-form').style.display = 'block';
}

function translateAuthError(msg) {
    if (!msg) return 'Неизвестная ошибка';
    const lower = msg.toLowerCase();
    if (lower.includes('invalid login credentials')) return 'Неверный email или пароль';
    if (lower.includes('user already registered')) return 'Пользователь с таким email уже зарегистрирован.';
    if (lower.includes('password should be at least 6 characters')) return 'Пароль должен быть не менее 6 символов.';
    if (lower.includes('signup disabled')) return 'Регистрация временно отключена.';
    if (lower.includes('email link is invalid or has expired')) return 'Ссылка недействительна или срок её действия истек.';
    if (lower.includes('rate limit exceeded')) return 'Слишком много попыток. Пожалуйста, подождите немного (обычно 1 час).';
    if (lower.includes('network error') || lower.includes('failed to fetch')) return 'Ошибка сети. Проверьте соединение с интернетом.';

    return msg;
}

function toggleAuthMode() {
    authMode = (authMode === 'login' ? 'register' : 'login');
    updateAuthModalLabels();
}

function updateAuthModalLabels() {
    const title = document.getElementById('auth-title');
    const submitBtn = document.getElementById('auth-submit-btn');
    const switchText = document.getElementById('auth-switch-text');
    const switchLink = document.getElementById('auth-switch-link');
    const forgotWrap = document.getElementById('auth-forgot-wrap');
    const emailInput = document.getElementById('auth-email');
    const passwordInput = document.getElementById('auth-password');
    const emailGroup = emailInput.closest('.input-group');
    const passGroup = passwordInput.closest('.input-group');
    const authSwitch = document.querySelector('.auth-switch');

    // Сброс видимости по умолчанию
    emailGroup.style.display = 'flex';
    passGroup.style.display = 'flex';
    authSwitch.style.display = 'block';
    forgotWrap.style.display = 'block';

    // Сброс required
    emailInput.required = true;
    passwordInput.required = true;

    if (authMode === 'login') {
        title.innerText = 'Вход';
        submitBtn.innerText = 'Войти';
        switchText.innerText = 'Нет аккаунта?';
        switchLink.innerText = 'Зарегистрироваться';
    } else if (authMode === 'register') {
        title.innerText = 'Регистрация';
        submitBtn.innerText = 'Создать аккаунт';
        switchText.innerText = 'Уже есть аккаунт?';
        switchLink.innerText = 'Войти';
        forgotWrap.style.display = 'none';
    } else if (authMode === 'reset-password') {
        title.innerText = 'Сброс пароля';
        submitBtn.innerText = 'Отправить письмо';
        passGroup.style.display = 'none';
        passwordInput.required = false; // Отключаем, так как поле скрыто
        switchText.innerText = 'Вспомнили пароль?';
        switchLink.innerText = 'Войти';
        forgotWrap.style.display = 'none';
    } else if (authMode === 'update-password') {
        title.innerText = 'Новый пароль';
        submitBtn.innerText = 'Сохранить';
        emailGroup.style.display = 'none';
        emailInput.required = false; // Отключаем
        authSwitch.style.display = 'none';
        forgotWrap.style.display = 'none';
    }
}

async function logout() {
    if (supabaseClient) {
        await supabaseClient.auth.signOut();
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
        setStatus('Укажите оба пункта (Откуда и Куда)');
        return;
    }

    const viaInputs = Array.from(document.querySelectorAll('.via-point-input'))
        .map(input => input.value.trim())
        .filter(val => val !== '');

    onBuildRoute(fromInput, toInput, viaInputs);
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

function onBuildRoute(fromInput, toInput, viaInputs = []) {
    setStatus('Геокодирование адресов...');

    const geocodePromises = [
        ymaps.geocode(fromInput),
        ...viaInputs.map(v => ymaps.geocode(v)),
        ymaps.geocode(toInput)
    ];

    Promise.all(geocodePromises).then(function (results) {
        const fromGeoObj = results[0].geoObjects.get(0);
        const toGeoObj = results[results.length - 1].geoObjects.get(0);

        if (!fromGeoObj || !toGeoObj) {
            setStatus('Город не найден. Проверьте написание.');
            return;
        }

        originGeo = fromGeoObj.geometry.getCoordinates(); // [lat, lon]
        destGeo = toGeoObj.geometry.getCoordinates();
        originName = fromInput;
        destName = toInput;

        userViaPoints = [];
        for (let i = 0; i < viaInputs.length; i++) {
            const viaObj = results[i + 1].geoObjects.get(0);
            if (viaObj) {
                const coords = viaObj.geometry.getCoordinates();
                userViaPoints.push({
                    lat: coords[0],
                    lon: coords[1],
                    name: viaInputs[i]
                });
            }
        }

        // Сбрасываем предыдущие заезды при новом маршруте
        selectedWaypoints = [];
        baseRouteGeoJsonCoords = null;

        // Включаем фильтр по расстоянию от трассы
        document.getElementById('show-all').checked = false;
        document.getElementById('distance-slider-group').style.display = 'block';

        if (window.innerWidth <= 600 && window.closeSidebar) {
            window.closeSidebar();
        }

        setStatus(`Маршрут рассчитан: ${originName} — ${destName}`);
        requestRouteAndRedraw();
        document.getElementById('reset-route').style.display = 'block';

    }).catch(function (error) {
        console.error('Ошибка геокодирования:', error);
        setStatus('Ошибка геокодирования. Возможно, не указан или неверен API-ключ Яндекса.');
    });
}

function onBuildRouteFuelClick() {
    const fromInput = document.getElementById('route-from').value.trim();
    const toInput = document.getElementById('route-to').value.trim();

    if (!fromInput || !toInput) {
        setStatus('Укажите оба пункта (Откуда и Куда)');
        return;
    }

    const viaInputs = Array.from(document.querySelectorAll('.via-point-input'))
        .map(input => input.value.trim())
        .filter(val => val !== '');

    needsFuelPlanning = true;
    onBuildRoute(fromInput, toInput, viaInputs);
}

async function planFuelRoute() {
    if (!routeGeoJsonCoords || routeGeoJsonCoords.length < 2) {
        console.warn('Fuel Planning: No route coordinates available');
        return;
    }

    const consumption = parseFloat(document.getElementById('fuel-consumption').value) || 10;
    const tankVolume = parseFloat(document.getElementById('fuel-tank').value) || 20;
    const initialPercent = parseFloat(document.getElementById('fuel-initial').value) || 50;

    // Математический расчет запаса
    const totalRange = (tankVolume / consumption) * 100;
    const reserveRange = totalRange * 0.10; // 10% запаса
    const usableRange = totalRange - reserveRange;

    let currentPosOnRoute = 0;
    let currentTankRange = (totalRange * (initialPercent / 100)) - reserveRange;

    // Если начальный уровень топлива уже ниже 10%, мы должны заправиться немедленно (в пределах оставшегося топлива)
    if (currentTankRange < 0) {
        currentTankRange = (totalRange * (initialPercent / 100)); // Используем всё что есть до нуля
    }

    console.log(`Greedy Planning: Range=${totalRange.toFixed(1)}km, Usable=${usableRange.toFixed(1)}km, StartBudget=${currentTankRange.toFixed(1)}km`);
    setStatus('Оптимальный расчет остановок...');

    const baseLine = turf.lineString(routeGeoJsonCoords);
    const totalDistKm = turf.length(baseLine, { units: 'kilometers' });

    // 1. Собираем всех кандидатов в радиусе 15км от трассы
    const allCngStations = allFeatures.filter(f => {
        const props = f.properties;
        return (props.amenities && props.amenities.cng) || (props.categories && props.categories.cng);
    });

    const candidates = [];
    allCngStations.forEach(st => {
        const [stLat, stLon] = st.geometry.coordinates;
        const stPoint = turf.point([stLon, stLat]);

        // Расстояние от заправки до всей линии маршрута
        const distToLine = turf.pointToLineDistance(stPoint, baseLine, { units: 'kilometers' });
        if (distToLine < 15) {
            // Проецируем точку на линию, чтобы узнать расстояние от начала маршрута
            const snapped = turf.nearestPointOnLine(baseLine, stPoint, { units: 'kilometers' });
            candidates.push({
                st,
                dist: snapped.properties.location, // Дистанция от старта в км
                coords: [stLat, stLon]
            });
        }
    });

    // Сортируем кандидатов по дистанции от начала
    candidates.sort((a, b) => a.dist - b.dist);
    console.log(`Found ${candidates.length} candidate stations near route.`);

    const stopsToAdd = [];
    let d = 0;
    let budget = currentTankRange;
    let lastStopDist = 0;

    // Жадный алгоритм: идем как можно дальше
    while (lastStopDist + budget < totalDistKm) {
        const jumpLimit = lastStopDist + budget;

        // Ищем самую дальнюю заправку в зоне досягаемости (budget)
        let bestCandidate = null;
        for (const cand of candidates) {
            if (cand.dist > lastStopDist && cand.dist <= jumpLimit) {
                if (!bestCandidate || cand.dist > bestCandidate.dist) {
                    bestCandidate = cand;
                }
            }
        }

        if (!bestCandidate) {
            // Разрыв слишком велик
            console.warn(`Insufficient infrastructure at ${lastStopDist.toFixed(1)} km. Gap exceeds budget ${budget.toFixed(1)} km.`);
            alert(`ВНИМАНИЕ: Маршрут не рекомендуется. Между станциями слишком большой разрыв в районе ${(lastStopDist + budget).toFixed(0)} км.`);
            setStatus('Маршрут не рекомендуется (разрыв)');
            break;
        }

        // Добавляем остановку
        stopsToAdd.push({
            id: String(bestCandidate.st.id),
            name: bestCandidate.st.properties.nameClean,
            lat: bestCandidate.coords[0],
            lon: bestCandidate.coords[1]
        });

        lastStopDist = bestCandidate.dist;
        budget = usableRange; // После заправки бюджет — полный бак минус 10%
        console.log(`Selected stop: ${bestCandidate.st.properties.nameClean} at ${lastStopDist.toFixed(1)} km`);
    }

    if (stopsToAdd.length > 0) {
        console.log(`Optimal stops found: ${stopsToAdd.length}`);
        selectedWaypoints = [...selectedWaypoints, ...stopsToAdd];

        // Итоговая сортировка (на всякий случай)
        if (baseRouteGeoJsonCoords) {
            const tempBaseLine = turf.lineString(baseRouteGeoJsonCoords);
            selectedWaypoints.sort((a, b) => {
                const locA = turf.nearestPointOnLine(tempBaseLine, turf.point([a.lon, a.lat])).properties.location || 0;
                const locB = turf.nearestPointOnLine(tempBaseLine, turf.point([b.lon, b.lat])).properties.location || 0;
                return locA - locB;
            });
        }
        requestRouteAndRedraw();
    } else if (lastStopDist + budget >= totalDistKm) {
        setStatus('Заправок по пути не требуется.');
    }
}
// Сброс маршрута
function resetRoute() {
    originGeo = null;
    destGeo = null;
    originName = '';
    destName = '';
    userViaPoints = [];
    selectedWaypoints = [];
    routeGeoJsonCoords = null;
    baseRouteGeoJsonCoords = null;

    if (routeObj) {
        myMap.geoObjects.remove(routeObj);
        routeObj = null;
    }

    document.getElementById('route-from').value = '';
    document.getElementById('route-to').value = '';

    const viaContainer = document.getElementById('via-points-container');
    if (viaContainer) {
        viaContainer.innerHTML = ''; // Очищаем все добавленные точки
    }

    document.getElementById('status').innerText = '';
    document.getElementById('reset-route').style.display = 'none';
    document.getElementById('save-route-btn').style.display = 'none'; // Скрываем и эту кнопку

    updateRouteSidebar();
    filterAndRenderStations();
}

// Построение маршрута
function requestRouteAndRedraw() {
    if (!originGeo || !destGeo) return;

    setStatus('Прокладываю маршрут…');

    let allStops = [];
    userViaPoints.forEach(v => allStops.push({ type: 'via', lat: v.lat, lon: v.lon, name: v.name }));
    selectedWaypoints.forEach((w, index) => allStops.push({ type: 'gas', lat: w.lat, lon: w.lon, name: w.name, gasIndex: index }));

    // Если есть базовый маршрут, отсортируем все остановки по расстоянию вдоль него
    if (baseRouteGeoJsonCoords) {
        const tempBaseLine = turf.lineString(baseRouteGeoJsonCoords);
        allStops.sort((a, b) => {
            const locA = turf.nearestPointOnLine(tempBaseLine, turf.point([a.lon, a.lat])).properties.location || 0;
            const locB = turf.nearestPointOnLine(tempBaseLine, turf.point([b.lon, b.lat])).properties.location || 0;
            return locA - locB;
        });
    }

    const routePoints = [
        originGeo,
        ...allStops.map(s => ({ type: 'wayPoint', point: [s.lat, s.lon] })),
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

        // Сохранение базового маршрута (эталон для сортировки) и центрирование
        if (!baseRouteGeoJsonCoords) {
            baseRouteGeoJsonCoords = routeGeoJsonCoords;
            myMap.setBounds(routeObj.geometry.getBounds(), {
                checkZoomRange: true,
                zoomMargin: isMobile ? [10, 10, 40, 10] : 30
            });
        }

        updateRouteSidebar();
        filterAndRenderStations();
        setStatus('Маршрут готов!');

        if (needsFuelPlanning) {
            needsFuelPlanning = false;
            planFuelRoute();
        }

        // Показываем кнопку "Сохранить маршрут" если маршрут готов
        if (currentUser) {
            document.getElementById('save-route-btn').style.display = 'block';
        }

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

    let allStops = [];
    userViaPoints.forEach(v => allStops.push({ type: 'via', lat: v.lat, lon: v.lon, name: v.name }));
    selectedWaypoints.forEach((w, index) => allStops.push({ type: 'gas', lat: w.lat, lon: w.lon, name: w.name, gasIndex: index }));

    if (baseRouteGeoJsonCoords) {
        const tempBaseLine = turf.lineString(baseRouteGeoJsonCoords);
        allStops.sort((a, b) => {
            const locA = turf.nearestPointOnLine(tempBaseLine, turf.point([a.lon, a.lat])).properties.location || 0;
            const locB = turf.nearestPointOnLine(tempBaseLine, turf.point([b.lon, b.lat])).properties.location || 0;
            return locA - locB;
        });
    }

    // Показываем/скрываем заголовок "Заезды по пути"
    const titleEl = document.getElementById('waypoints-title');
    if (titleEl) {
        titleEl.style.display = allStops.length > 0 ? 'block' : 'none';
    }

    listEl.innerHTML = '';

    const rtextParts = [`${originGeo[0]},${originGeo[1]}`];

    allStops.forEach((wp, index) => {
        rtextParts.push(`${wp.lat},${wp.lon}`);

        const stopEl = document.createElement('div');
        stopEl.className = 'route-stop';
        if (wp.type === 'gas') {
            stopEl.innerHTML = `
                <div class="route-stop-title">${index + 1}. ${wp.name}</div>
                <button class="remove-btn" onclick="removeStation(${wp.gasIndex})" title="Удалить">✖</button>
            `;
        } else {
            stopEl.innerHTML = `
                <div class="route-stop-title">${index + 1}. ${wp.name} (Город/Адрес)</div>
            `;
        }
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

    // Запоминаем ID открытого балуна, чтобы он не закрылся при перерисовке
    const openBalloonData = objectManager.objects.balloon.getData();
    const openId = openBalloonData ? openBalloonData.id : null;

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

    // Восстанавливаем открытый балун, если объект всё еще виден
    if (openId && objectManager.objects.getById(openId)) {
        objectManager.objects.balloon.open(openId);
    }
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
        if (key === 'is_favorite') {
            return favoriteStations.includes(feature.id);
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
    const isFav = favoriteStations.includes(stId);

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

    // Группа кнопок действий
    html += `<div class="balloon-actions">`;

    if (isRouteActive) {
        const alreadyAdded = selectedWaypoints.some(w => w.id == stId);
        html += alreadyAdded
            ? `<button class="yandex-link-btn" disabled>✓ Добавлена</button>`
            : `<button class="yandex-link-btn" onclick="addStationToRoute('${stId}')">➕ Заехать сюда</button>`;
    } else {
        html += `<a href="${singleNavLink}" target="_blank" class="yandex-link-btn">🚗 Отправиться сюда</a>`;
    }

    // Кнопка Избранного
    html += `
        <button class="fav-btn-balloon ${isFav ? 'active' : ''}" onclick="toggleFavorite('${stId}')" title="${isFav ? 'Убрать из избранного' : 'В избранное'}">
            ${isFav ? '⭐' : '☆'}
        </button>
    `;

    // Кнопка репорта (⚠️)
    html += `<button class="balloon-report-err-btn" onclick="openReportModal('${stId}')" title="Сообщить об ошибке">⚠️</button>`;

    html += `</div>`; // .balloon-actions

    html += `<button class="yandex-link-btn-secondary" onclick="window.open('${placeLink}', '_blank')" style="margin-top: 10px;">🗺️ Посмотреть на Яндекс Картах</button>`;

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
                guideList.appendChild(li);
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
        let allData = [];
        let from = 0;
        let to = 999;
        let finished = false;

        console.log('[Supabase] Start multi-page fetch...');

        while (!finished) {
            const { data, error } = await supabaseClient
                .from('comments')
                .select('id, station_id, text, date, author_email')
                .order('created_at', { ascending: false })
                .range(from, to);

            if (error) {
                console.error('Supabase fetch error:', error);
                break;
            }

            if (data && data.length > 0) {
                allData = allData.concat(data);
                if (data.length < 1000) {
                    finished = true;
                } else {
                    from += 1000;
                    to += 1000;
                }
            } else {
                finished = true;
            }
            
            // Защита от бесконечного цикла
            if (from > 10000) break; 
        }

        if (allData.length > 0) {
            userComments = {};
            allData.forEach(c => {
                if (!userComments[c.station_id]) userComments[c.station_id] = [];
                userComments[c.station_id].push({
                    text: c.text,
                    date: c.date,
                    author_email: c.author_email
                });
            });
            window.totalCommentsLoaded = allData.length;
            console.log(`[Supabase] Total loaded: ${allData.length} comments.`);

            // После загрузки обновляем открытые и закрытые баллоны
            const openCommentsLists = document.querySelectorAll('div[id^="comments-list-"]');
            openCommentsLists.forEach(list => {
                const stId = list.id.replace('comments-list-', '');
                console.log(`Polling: refreshing open balloon for station ${stId}`);
                list.innerHTML = buildCommentsHtml(stId);
            });

            // Принудительно обновляем все баллоны на карте, чтобы в них появились отзывы
            filterAndRenderStations();
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
    // Отображаем как есть (уже отсортировано от новых к старым при загрузке)
    return comments.map(c => `
        <div class="comment-item">
            <div class="comment-text">${escapeHtml(c.text)}</div>
            <div class="comment-meta">
                ${c.author_email ? `<span class="comment-author" title="${c.author_email}">${c.author_email.split('@')[0]}</span> • ` : ''}
                ${c.date}
            </div>
            ${c.id && c.id.length > 5 ? `<div style="display:none" class="comment-id-marker" data-id="${c.id}"></div>` : ''}
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
        let missing = [];
        if (typeof CONFIG === 'undefined') missing.push('CONFIG undefined');
        else {
            if (!CONFIG.SUPABASE_URL) missing.push('SUPABASE_URL');
            if (!CONFIG.SUPABASE_ANON_KEY) missing.push('SUPABASE_ANON_KEY');
        }
        alert('Система отзывов не настроена: ' + (missing.length ? 'отсутствуют [' + missing.join(', ') + ']' : 'причина неизвестна'));
        return;
    }

    const now = new Date();
    const dateStr = `${String(now.getDate()).padStart(2, '0')}.${String(now.getMonth() + 1).padStart(2, '0')}.${now.getFullYear()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    try {
        const newComment = {
            station_id: String(stationId),
            text,
            date: dateStr,
            user_id: currentUser?.id || null,
            author_email: currentUser?.email || null
        };

        const { error } = await supabaseClient
            .from('comments')
            .insert([newComment]);

        if (!error) {
            input.value = '';
            // Локально обновляем данные для мгновенного отображения
            if (!userComments[stationId]) userComments[stationId] = [];
            userComments[stationId].push({
                text,
                date: dateStr,
                author_email: currentUser?.email || null
            });

            // Перерисовываем весь балун, чтобы обновить состояние (новости, флаги и т.д.)
            objectManager.objects.balloon.setData(objectManager.objects.getById(stationId));

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
let savedRoutes = [];

async function fetchSavedRoutes() {
    if (!supabaseClient || !currentUser) return;
    try {
        const { data, error } = await supabaseClient
            .from('saved_routes')
            .select('*')
            .order('created_at', { ascending: false });

        if (!error && data) {
            savedRoutes = data;
            renderSavedRoutes();
            console.log('Saved routes loaded:', savedRoutes.length);
        } else if (error) {
            console.warn('Error fetching routes:', error);
        }
    } catch (e) {
        console.error('Saved routes exception:', e);
    }
}

async function saveCurrentRoute(name) {
    if (!supabaseClient || !currentUser) {
        alert('Войдите, чтобы сохранять маршруты');
        return;
    }

    if (!originGeo || !destGeo) {
        alert('Сначала проложите маршрут');
        return;
    }

    // Проверка корректности координат (Yandex возвращает [lat, lon])
    if (isNaN(originGeo[0]) || isNaN(originGeo[1]) || isNaN(destGeo[0]) || isNaN(destGeo[1])) {
        alert('Ошибка в координатах маршрута. Попробуйте еще раз.');
        console.error('Invalid coords for saving:', { originGeo, destGeo });
        return;
    }

    try {
        const newRoute = {
            user_id: currentUser.id,
            name: name || `Маршрут от ${new Date().toLocaleDateString()}`,
            origin_name: originName || 'Точка А',
            dest_name: destName || 'Точка Б',
            origin_coords: originGeo,
            dest_coords: destGeo,
            waypoints: selectedWaypoints || []
        };

        console.log('Saving route to Supabase...', newRoute);

        const { data, error } = await supabaseClient
            .from('saved_routes')
            .insert([newRoute])
            .select();

        if (!error && data) {
            savedRoutes.unshift(data[0]);
            renderSavedRoutes();
            closeSaveRouteModal();
            console.log('Route saved successfully:', data[0]);
        } else {
            console.error('Supabase error saving route:', error);
            alert(`Ошибка при сохранении: ${error?.message || 'Неизвестная ошибка'}`);
        }
    } catch (e) {
        console.error('Save route exception:', e);
        alert('Внутренняя ошибка при сохранении');
    }
}

async function deleteSavedRoute(id) {
    if (!confirm('Удалить этот маршрут?')) return;

    try {
        const { error } = await supabaseClient
            .from('saved_routes')
            .delete()
            .eq('id', id);

        if (!error) {
            savedRoutes = savedRoutes.filter(r => r.id !== id);
            renderSavedRoutes();
            console.log('Route deleted');
        } else {
            console.error('Error deleting route:', error);
        }
    } catch (e) {
        console.error('Delete route exception:', e);
    }
}

function renderSavedRoutes() {
    const listEl = document.getElementById('routes-list');
    if (!listEl) return;

    if (savedRoutes.length === 0) {
        listEl.innerHTML = '<div class="loading-placeholder">У вас пока нет сохраненных маршрутов.</div>';
        return;
    }

    listEl.innerHTML = savedRoutes.map(r => `
        <div class="route-card">
            <div class="route-card-title">${escapeHtml(r.name)}</div>
            <div class="route-card-path">
                ${escapeHtml(r.origin_name || 'Точка А')} → ${escapeHtml(r.dest_name || 'Точка Б')}
                ${r.waypoints.length > 0 ? `<br><small>(${r.waypoints.length} заправок по пути)</small>` : ''}
            </div>
            <div class="route-card-actions">
                <button class="card-action-btn" onclick="loadSavedRoute('${r.id}')">Загрузить</button>
                <button class="card-action-btn delete" onclick="deleteSavedRoute('${r.id}')">Удалить</button>
            </div>
        </div>
    `).join('');
}

window.loadSavedRoute = function (id) {
    const route = savedRoutes.find(r => r.id === id);
    if (!route) return;

    // Сброс текущего состояния
    resetRoute();

    // Восстановление
    document.getElementById('route-from').value = route.origin_name || '';
    document.getElementById('route-to').value = route.dest_name || '';
    originName = route.origin_name || '';
    destName = route.dest_name || '';

    // Сохраняем координаты как массивы
    originGeo = route.origin_coords;
    destGeo = route.dest_coords;

    selectedWaypoints = JSON.parse(JSON.stringify(route.waypoints));

    // Настраиваем фильтрацию: убираем лишние заправки
    const showAllCb = document.getElementById('show-all');
    if (showAllCb) {
        showAllCb.checked = false;
        document.getElementById('distance-slider-group').style.display = 'block';
    }

    closeRoutesModal();
    requestRouteAndRedraw();
};

function openRoutesModal() {
    document.getElementById('routes-modal').style.display = 'flex';
    fetchSavedRoutes();
}

function closeRoutesModal() {
    document.getElementById('routes-modal').style.display = 'none';
}

function openSaveRouteModal() {
    if (!currentUser) {
        openAuthModal('login');
        return;
    }
    document.getElementById('save-route-modal').style.display = 'flex';
}

function closeSaveRouteModal() {
    document.getElementById('save-route-modal').style.display = 'none';
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

/** РАБОТА С ИЗБРАННЫМ **/

async function toggleFavorite(stId) {
    const index = favoriteStations.indexOf(stId);
    let isAdding = false;
    if (index === -1) {
        favoriteStations.push(stId);
        isAdding = true;
    } else {
        favoriteStations.splice(index, 1);
        isAdding = false;
    }

    saveFavorites();

    // Синхронизация с облаком
    if (currentUser) {
        if (isAdding) {
            await syncFavoriteToSupabase(stId);
        } else {
            await removeFavoriteFromSupabase(stId);
        }
    }

    // Находим все открытые балуны и обновляем текст кнопки, если нужно
    const btn = document.querySelector('.fav-btn-balloon');
    if (btn) {
        const isFav = favoriteStations.includes(stId);
        btn.classList.toggle('active', isFav);
        btn.innerHTML = isFav ? '⭐' : '☆';
    }
}

function goToStation(stId) {
    // Находим объект
    if (!objectManager) return;

    const obj = objectManager.objects.getById(stId);
    if (obj) {
        const coords = obj.geometry.coordinates;
        myMap.setCenter(coords, 14, { duration: 500 });

        // Открываем балун через небольшую задержку
        setTimeout(() => {
            objectManager.objects.balloon.open(stId);
        }, 600);
    } else {
        // Если объект не в текущем вьюпорте или не загружен (маловероятно для ObjectManager)
        console.warn('Станция не найдена на карте:', stId);
    }
}

// === РАБОТА С ОШИБКАМИ (REPORT ERROR) ===

window.openReportModal = function (stationId = null) {
    const modal = document.getElementById('report-modal');
    const stationIdInput = document.getElementById('report-station-id');
    const stationNameDiv = document.getElementById('report-station-name');
    const emailInput = document.getElementById('report-email');
    const typeContainer = document.getElementById('report-type-container');

    // Сброс формы
    document.getElementById('report-form').reset();
    document.getElementById('report-error').style.display = 'none';
    document.getElementById('report-success').style.display = 'none';

    // Подготовка вариантов ошибок
    let options = [];
    if (stationId) {
        options = [
            { value: 'not_exists', text: 'Заправки не существует' },
            { value: 'coordinates', text: 'Ошибка в координатах' },
            { value: 'closed', text: 'Заправка закрыта/не работает' },
            { value: 'other', text: 'Другое' }
        ];
    } else {
        options = [
            { value: 'price', text: 'Не указана заправка' },
            { value: 'coordinates', text: 'Ошибка в координатах' },
            { value: 'closed', text: 'Заправка закрыта/не работает' },
            { value: 'other', text: 'Другое' }
        ];
    }

    // Рендерим радио-кнопки
    typeContainer.innerHTML = options.map((opt, index) => `
        <label>
            <input type="radio" name="error_type" value="${opt.value}" ${index === 0 ? 'required' : ''}>
            ${opt.text}
        </label>
    `).join('');

    if (stationId) {
        stationIdInput.value = stationId;

        // Находим название станции по ID
        let stationName = 'Заправка';
        const st = allFeatures.find(f => f.id === stationId);
        if (st && st.properties && st.properties.nameClean) {
            stationName = st.properties.nameClean;
        }

        stationNameDiv.innerText = `Станция: ${stationName}`;
        stationNameDiv.style.display = 'block';
    } else {
        stationIdInput.value = '';
        stationNameDiv.style.display = 'none';
    }

    if (currentUser?.email) {
        emailInput.value = currentUser.email;
    }

    modal.style.display = 'flex';
};

function closeReportModal() {
    document.getElementById('report-modal').style.display = 'none';
}

async function submitErrorReport(e) {
    e.preventDefault();

    if (!supabaseClient) {
        alert('Система отправки ошибок не настроена.');
        return;
    }

    const submitBtn = document.getElementById('report-submit-btn');
    const errorEl = document.getElementById('report-error');
    const successEl = document.getElementById('report-success');

    const stationId = document.getElementById('report-station-id').value;
    const errorType = document.querySelector('input[name="error_type"]:checked')?.value;
    const description = document.getElementById('report-description').value;
    const email = document.getElementById('report-email').value;

    if (!errorType) {
        errorEl.innerText = 'Выберите тип ошибки';
        errorEl.style.display = 'block';
        return;
    }

    submitBtn.disabled = true;
    submitBtn.innerText = 'Отправка...';
    errorEl.style.display = 'none';

    try {
        const { error } = await supabaseClient
            .from('error_reports')
            .insert([{
                station_id: stationId || null,
                error_type: errorType,
                description: description,
                author_email: email,
                user_id: currentUser?.id || null
            }]);

        if (error) throw error;

        successEl.innerText = 'Спасибо! Информация отправлена на модерацию.';
        successEl.style.display = 'block';
        document.getElementById('report-form').style.display = 'none';

        setTimeout(() => {
            closeReportModal();
            // Сбрасываем видимость формы для следующего раза
            document.getElementById('report-form').style.display = 'block';
        }, 3000);

    } catch (err) {
        console.error('Error submitting report:', err);
        errorEl.innerText = 'Ошибка при отправке: ' + err.message;
        errorEl.style.display = 'block';
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerText = 'Отправить';
    }
}

// Вызываем фильтрацию при загрузке
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(filterAndRenderStations, 1000); // Даем время на загрузку данных
});

// Подписка на новые комментарии в реальном времени
function subscribeToComments() {
    if (!supabaseClient) return;

    console.log('Subscribing to real-time comments...');

    supabaseClient
        .channel('public:comments')
        .on('postgres_changes', {
            event: 'INSERT',
            schema: 'public',
            table: 'comments'
        }, payload => {
            console.log('New comment received via Realtime:', payload.new);
            const newComment = payload.new;
            const stId = newComment.station_id;

            // Обновляем локальный кэш
            if (!userComments[stId]) userComments[stId] = [];

            // Проверяем, нет ли уже такого комментария (чтобы не дублировать для автора)
            const exists = userComments[stId].some(c => c.id === newComment.id);
            if (!exists) {
                userComments[stId].push({
                    id: newComment.id,
                    text: newComment.text,
                    date: newComment.date,
                    author: newComment.author_email || 'Аноним'
                });

                // Обновляем UI, если открыт балун именно этой заправки
                const list = document.getElementById(`comments-list-${stId}`);
                if (list) {
                    console.log(`Updating comments list for station ${stId}`);
                    list.innerHTML = buildCommentsHtml(stId);
                }
            }
        })
        .subscribe();
}
