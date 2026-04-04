import http.server
import json
import os
import datetime
import update_agnks_ru
from urllib.parse import urlparse, parse_qs

PORT = 8080
GAZPROM_API_URL = "https://gazprom-agnks.ru/get-all-map-data"
GAZPROM_CACHE_FILE = 'gazprom_stations_cache.json'
GAZPROM_CACHE_TTL = 3600  # 1 час

def fetch_gazprom_data():
    import time
    import urllib.request
    import urllib.error

    # Проверяем кэш
    if os.path.exists(GAZPROM_CACHE_FILE):
        mtime = os.path.getmtime(GAZPROM_CACHE_FILE)
        if time.time() - mtime < GAZPROM_CACHE_TTL:
            try:
                with open(GAZPROM_CACHE_FILE, 'r', encoding='utf-8') as f:
                    return f.read(), True
            except:
                pass

    # Если кэш просрочен или ошибка, тянем свежее
    print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] Fetching fresh data from {GAZPROM_API_URL}...")
    try:
        # Сайт Газпрома может требовать User-Agent
        req = urllib.request.Request(
            GAZPROM_API_URL, 
            headers={'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'}
        )
        with urllib.request.urlopen(req, timeout=10) as response:
            data = response.read().decode('utf-8')
            # Сохраняем в кэш
            try:
                with open(GAZPROM_CACHE_FILE, 'w', encoding='utf-8') as f:
                    f.write(data)
            except:
                pass
            return data, True
    except Exception as e:
        print(f"Error fetching Gazprom data: {e}")
        # Пытаемся вернуть просроченный кэш как fallback
        if os.path.exists(GAZPROM_CACHE_FILE):
            try:
                with open(GAZPROM_CACHE_FILE, 'r', encoding='utf-8') as f:
                    return f.read(), True
            except:
                pass
        # Если и кэша нет, пробуем локальный gazprom_stations.json (если он есть)
        if os.path.exists('gazprom_stations.json'):
            try:
                with open('gazprom_stations.json', 'r', encoding='utf-8') as f:
                    return f.read(), True
            except:
                pass
        return json.dumps({"error": str(e)}), False

def fetch_agnks_ru_data():
    import time
    cache_file = 'agnks_ru.json'
    ttl = 3600

    if os.path.exists(cache_file):
        mtime = os.path.getmtime(cache_file)
        if time.time() - mtime < ttl:
            try:
                with open(cache_file, 'r', encoding='utf-8') as f:
                    return f.read(), True
            except:
                pass

    # fetch fresh
    success = update_agnks_ru.fetch_and_parse()
    if success and os.path.exists(cache_file):
        try:
            with open(cache_file, 'r', encoding='utf-8') as f:
                return f.read(), True
        except:
            pass

    # fallback
    if os.path.exists(cache_file):
        try:
            with open(cache_file, 'r', encoding='utf-8') as f:
                return f.read(), True
        except:
            pass
    return json.dumps({"error": "Failed to fetch agnks.ru data"}), False

class MyHandler(http.server.SimpleHTTPRequestHandler):
    def get_suggest_key(self):
        """Пытаемся достать ключ из config.js или переменных окружения"""
        try:
            if os.path.exists('config.js'):
                with open('config.js', 'r', encoding='utf-8') as f:
                    import re
                    content = f.read()
                    match = re.search(r"YANDEX_SUGGEST_API_KEY:\s*'([^']+)'", content)
                    if match:
                        return match.group(1)
        except:
            pass
        return os.environ.get('YANDEX_SUGGEST_API_KEY', '')

    def fetch_gazprom_stations(self):
        return fetch_gazprom_data()

    def fetch_agnks_ru_stations(self):
        return fetch_agnks_ru_data()

    def do_GET(self):
        parsed_path = urlparse(self.path)
        if parsed_path.path == '/api/gazprom_stations':
            data, success = self.fetch_gazprom_stations()
            self.send_response(200 if success else 500)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', f'max-age={GAZPROM_CACHE_TTL}')
            self.end_headers()
            self.wfile.write(data.encode('utf-8'))
        elif parsed_path.path == '/api/agnks_ru_stations':
            data, success = self.fetch_agnks_ru_stations()
            self.send_response(200 if success else 500)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', f'max-age={GAZPROM_CACHE_TTL}')
            self.end_headers()
            self.wfile.write(data.encode('utf-8'))
        elif parsed_path.path == '/api/suggest':
            query = parse_qs(parsed_path.query)
            text = query.get('text', [''])[0]
            
            if not text:
                self.send_error(400, "Missing text parameter")
                return

            apikey = self.get_suggest_key()
            if not apikey:
                self.send_error(500, "Suggest API key not configured")
                return

            # Проксируем запрос к Яндексу
            import urllib.request
            url = f"https://suggest-maps.yandex.ru/v1/suggest?apikey={apikey}&text={urllib.parse.quote(text)}&print_address=1"
            
            try:
                with urllib.request.urlopen(url) as response:
                    data = response.read()
                    self.send_response(200)
                    self.send_header('Content-type', 'application/json')
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.end_headers()
                    self.wfile.write(data)
            except Exception as e:
                self.send_error(500, str(e))
        else:
            # Default to static file serving
            super().do_GET()

def background_updater():
    """Фоновое обновление данных Газпрома раз в час"""
    import time
    while True:
        try:
            fetch_gazprom_data()
        except Exception as e:
            print(f"Background update error (Gazprom): {e}")
            
        try:
            fetch_agnks_ru_data()
        except Exception as e:
            print(f"Background update error (Agnks Ru): {e}")
            
        time.sleep(GAZPROM_CACHE_TTL)

if __name__ == '__main__':
    import threading
    import datetime
    
    # Запускаем фоновый поток для обновления данных
    updater_thread = threading.Thread(target=background_updater, daemon=True)
    updater_thread.start()
    
    print(f"Starting server on port {PORT}...")
    server = http.server.HTTPServer(('', PORT), MyHandler)
    server.serve_forever()
