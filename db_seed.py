import urllib.request
import json
import datetime
import random

# Конфигурация
try:
    with open('config.js', 'r', encoding='utf-8') as f:
        content = f.read()
        import re
        url_match = re.search(r"SUPABASE_URL:\s*'([^']+)'", content)
        key_match = re.search(r"SUPABASE_ANON_KEY:\s*'([^']+)'", content)
        SUPABASE_URL = url_match.group(1) if url_match else None
        SUPABASE_KEY = key_match.group(1) if key_match else None
except:
    SUPABASE_URL = None
    SUPABASE_KEY = None

if not SUPABASE_URL:
    SUPABASE_URL = input("Введите Supabase URL: ").strip()
if not SUPABASE_KEY:
    SUPABASE_KEY = input("Введите Supabase Key (лучше Service Role): ").strip()

STATION_IDS = ['33504', '33506', '33508', '33887', '33929', '141cfe2', 'db70de1']

COMMENTS_DATA = [
    {"text": "Отличная заправка, давление 220!", "author_email": "driver1@test.com"},
    {"text": "Большая очередь в час пик.", "author_email": "user@mail.ru"},
    {"text": "Вежливый персонал, есть туалет и кофе.", "author_email": "eco_traveler@gmail.com"},
    {"text": "Сломан один пистолет, работает только одна колонка.", "author_email": "trucker@yandex.ru"},
    {"text": "Давление низкое, заправлялся долго.", "author_email": "anon@test.com"},
    {"text": "Заезд удобный, очередей нет.", "author_email": "ivan@ivanov.ru"},
]

ERROR_REPORTS = [
    {"error_type": "wrong_schedule", "description": "По факту перерыв с 13 до 14, в приложении не указано.", "author_email": "helper@test.com"},
    {"error_type": "wrong_address", "description": "Заезд через соседнюю улицу, на карте неточно.", "author_email": "map_guru@test.com"},
    {"error_type": "closed", "description": "Станция на реконструкции до конца месяца.", "author_email": "local@test.com"},
]

def send_request(table, data):
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    req = urllib.request.Request(
        url,
        data=json.dumps(data).encode(),
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
        print(f"Ошибка при вставке в {table}: {e}")
        return None

def seed_data():
    print("🚀 Начинаю заполнение БД тестовыми данными...")
    
    # 1. Заполняем комментарии
    print("📝 Добавляю комментарии...")
    for _ in range(15):
        comment = random.choice(COMMENTS_DATA).copy()
        comment['station_id'] = random.choice(STATION_IDS)
        comment['date'] = datetime.datetime.now().strftime("%d.%m.%Y %H:%M")
        send_request('comments', comment)
    
    # 2. Заполняем отчеты об ошибках
    print("⚠️ Добавляю отчеты об ошибках...")
    for _ in range(5):
        report = random.choice(ERROR_REPORTS).copy()
        report['station_id'] = random.choice(STATION_IDS)
        send_request('error_reports', report)

    print("\n✅ Заполнение завершено!")
    print("Примечание: Таблицы 'favorites' и 'saved_routes' требуют валидный user_id из таблицы auth.users, поэтому они не заполнялись автоматически.")

if __name__ == "__main__":
    seed_data()
