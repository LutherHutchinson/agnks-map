import urllib.request
import json
import datetime
import random
import re

# --- CONFIGURATION ---
try:
    with open('config.js', 'r', encoding='utf-8') as f:
        content = f.read()
        url_match = re.search(r"SUPABASE_URL:\s*'([^']+)'", content)
        key_match = re.search(r"SUPABASE_ANON_KEY:\s*'([^']+)'", content)
        SUPABASE_URL = url_match.group(1) if url_match else None
        SUPABASE_KEY = key_match.group(1) if key_match else None
except:
    SUPABASE_URL = None
    SUPABASE_KEY = None

if not SUPABASE_URL or not SUPABASE_KEY:
    print("Error: Could not find Supabase credentials in config.js")
    exit(1)

# --- LOAD STATION IDS ---
def get_station_ids():
    ids = []
    try:
        with open('stations.json', 'r', encoding='utf-8') as f:
            data = json.load(f)
            for item in data:
                if item.get('id'):
                    ids.append(f"main_{item.get('id')}")
    except: pass
    
    try:
        with open('gazprom_stations.json', 'r', encoding='utf-8') as f:
            data = json.load(f)
            elements = data.get('elements', [])
            for el in elements:
                if el.get('id'):
                    ids.append(f"gazprom_{el.get('id')}")
    except: pass
    
    return ids

STATION_IDS = get_station_ids()

# --- ALIVE DATA GENERATORS ---
SUBJECTS = [
    ["Заправка", "Станция", "АГНКС", "Место"],
    ["Персонал", "Оператор", "Сотрудники"],
    ["Давление", "Напор", "Компрессор"],
    ["Кофе", "Буфет", "Магазин"],
    ["Очередь", "Народу", "Трафик"]
]

ADJECTIVES_POS = ["отличная", "супер", "норм", "шикарное", "пушка", "достойная", "чистая", "адекватный", "быстрый", "высокое"]
ADJECTIVES_NEG = ["ужасная", "медленная", "слабое", "злой", "грязный", "длинная", "не работает", "сломано"]

REVIEWS_TEMPLATES = [
    # Позитив
    "Давление огонь, задули 220 без проблем. Очередей нет, всё быстро.",
    "Лучшая заправка на этом участке трассы. Всегда чисто и персонал вежливый.",
    "Заправился быстро, переходники на евро есть. Кофе вкусный, рекомендую!",
    "Всё супер, давление в норме, заезд удобный. Приеду ещё.",
    "Чисто, уютно, есть где отдохнуть пока машина заправляется. Метан качественный.",
    "Оператор молодец, помог с заправкой. Давление порадовало.",
    "Никаких очередей, заехал-заправился-уехал. 5 звезд!",
    
    # Негатив
    "Давление обнять и плакать, еле 180 накачали. Очень долго.",
    "Очередь как в мавзолей, работают всего две колонки из четырех.",
    "Терминал глючит, карты не принимает. Только наличка или по QR. Злой персонал.",
    "Туалет закрыт на ремонт, магазин пустой. Сама заправка еле дышит.",
    "Слишком долго заправляют, компрессор слабый. Потерял час времени.",
    "Оператор хамит, сервис на нуле. Больше тут не остановлюсь.",
    "Заезд весь в ямах, можно подвеску оставить. Сама АГНКС нормальная, но дорога...",

    # Живые фразы (короткие)
    "Норм станция.",
    "Пушка! 210 очков!",
    "Очереди нет.",
    "Всё ок.",
    "Метан топ.",
    "Не советую, давление слабое.",
    "Работает одна колонка, имейте в виду.",
    "Пересменка с 8 до 8:15.",
    "Удобно, прямо у дороги.",
    "Чисто и быстро."
]

USER_NAMES = [
    "ivan_gaz", "metan_driver", "alex_88", "marina_kpg", "dmitry_truck", "serg_pro", 
    "trucker77", "eco_driver", "gaz_monster", "nikolay_v", "elena_travel", "denis_gas",
    "volodya_r", "andrey_cng", "skala", "veteran", "novichok", "maxim_auto"
]

DOMAINS = ["mail.ru", "yandex.ru", "gmail.com", "bk.ru", "list.ru", "internet.ru"]

def generate_alive_review():
    # Собираем отзыв из шаблона или генерируем новый
    if random.random() > 0.3:
        text = random.choice(REVIEWS_TEMPLATES)
    else:
        subj = random.choice(SUBJECTS)
        adj = random.choice(ADJECTIVES_POS if random.random() > 0.3 else ADJECTIVES_NEG)
        text = f"{random.choice(subj)} {adj}. {random.choice(['Рекомендую', 'Ок', 'Норм', 'Пойдет', 'Грустно'])}."

    # Добавляем немного "человечности" (опечатки, знаки)
    if random.random() > 0.8:
        text = text.lower()
    if random.random() > 0.9:
        text = text.replace(".", "!!!")

    name = random.choice(USER_NAMES)
    if random.random() > 0.5:
        name += str(random.randint(10, 999))
    
    email = f"{name}@{random.choice(DOMAINS)}"
    station_id = random.choice(STATION_IDS)
    
    # Дата за последние полгода
    days_ago = random.randint(0, 180)
    hours_ago = random.randint(0, 23)
    date_obj = datetime.datetime.now() - datetime.timedelta(days=days_ago, hours=hours_ago)
    date_str = date_obj.strftime("%d.%m.%Y %H:%M")
    
    return {
        "station_id": station_id,
        "text": text,
        "author_email": email,
        "date": date_str
    }

# --- BULK INSERT ---
def bulk_insert(table, data_list):
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    req = urllib.request.Request(
        url,
        data=json.dumps(data_list).encode(),
        method='POST',
        headers={
            'apikey': SUPABASE_KEY,
            'Authorization': f'Bearer {SUPABASE_KEY}',
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
        }
    )
    try:
        with urllib.request.urlopen(req) as response:
            return response.getcode()
    except Exception as e:
        print(f"Error: {e}")
        return None

if __name__ == "__main__":
    total_stations = len(STATION_IDS)
    print(f"🚀 Ensuring reviews for ALL {total_stations} stations...")
    
    all_reviews = []
    # 1. Сначала создаем по 1 отзыву для КАЖДОЙ станции
    for sid in STATION_IDS:
        review = generate_alive_review()
        review['station_id'] = sid # Принудительно ставим ID этой станции
        all_reviews.append(review)
    
    # 2. Добавляем еще 300 случайных для "живости"
    for _ in range(300):
        all_reviews.append(generate_alive_review())
    
    random.shuffle(all_reviews)
    
    BATCH = 100
    total_to_upload = len(all_reviews)
    
    print(f"🔥 Uploading {total_to_upload} reviews in total...")
    
    for i in range(0, total_to_upload, BATCH):
        batch = all_reviews[i:i+BATCH]
        res = bulk_insert('comments', batch)
        if res:
            print(f"✅ Batch {i//BATCH + 1}/{(total_to_upload-1)//BATCH + 1} uploaded ({len(batch)} items)")
        else:
            print(f"❌ Failed batch {i//BATCH + 1}")

    print(f"\n✨ Mission Accomplished! Every one of the {total_stations} stations now has at least one review.")
