import http.server
import json
import os
import datetime
import time
import urllib.request
import urllib.error
import re
import threading
from urllib.parse import urlparse, parse_qs
import psycopg2
from psycopg2.extras import RealDictCursor
import jwt
from werkzeug.security import generate_password_hash, check_password_hash

PORT = 8080
GAZPROM_API_URL = "https://gazprom-agnks.ru/get-all-map-data"
GAZPROM_CACHE_FILE = 'gazprom_stations_cache.json'
GAZPROM_CACHE_TTL = 3600  # 1 час

# PostgreSQL Configuration
DATABASE_URL = os.environ.get('DATABASE_URL')

PG_HOST = os.environ.get('PGHOST', 'localhost')
PG_PORT = os.environ.get('PGPORT', '5432')
PG_DB = os.environ.get('PGDATABASE', 'agnks_db')
PG_USER = os.environ.get('PGUSER', 'postgres')
PG_PASS = os.environ.get('PGPASSWORD', '')

SECRET_KEY = os.environ.get('SECRET_KEY', 'default-key-change-me')


def get_db_connection():
    if DATABASE_URL:
        # Render/Heroku provide DATABASE_URL starting with postgres:// but psycopg2 prefers postgresql://
        url = DATABASE_URL.replace("postgres://", "postgresql://", 1)
        return psycopg2.connect(url)
    return psycopg2.connect(
        host=PG_HOST,
        port=PG_PORT,
        database=PG_DB,
        user=PG_USER,
        password=PG_PASS
    )


def init_db():
    print(f"Initializing PostgreSQL database: {PG_DB} at {PG_HOST}")
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Читаем и выполняем schema.sql
        if os.path.exists('schema.sql'):
            with open('schema.sql', 'r', encoding='utf-8') as f:
                cursor.execute(f.read())
        else:
            print("Warning: schema.sql not found!")
            
        conn.commit()
        cursor.close()
        conn.close()
        print("Database initialized successfully.")
    except Exception as e:
        print(f"Error initializing database: {e}")

def fetch_gazprom_data():
    if os.path.exists(GAZPROM_CACHE_FILE):
        mtime = os.path.getmtime(GAZPROM_CACHE_FILE)
        if time.time() - mtime < GAZPROM_CACHE_TTL:
            try:
                with open(GAZPROM_CACHE_FILE, 'r', encoding='utf-8') as f:
                    return f.read(), True
            except:
                pass

    print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] Fetching fresh data from {GAZPROM_API_URL}...")
    try:
        req = urllib.request.Request(
            GAZPROM_API_URL, 
            headers={'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'}
        )
        with urllib.request.urlopen(req, timeout=10) as response:
            data = response.read().decode('utf-8')
            try:
                with open(GAZPROM_CACHE_FILE, 'w', encoding='utf-8') as f:
                    f.write(data)
            except:
                pass
            return data, True
    except Exception as e:
        print(f"Error fetching Gazprom data: {e}")
        if os.path.exists(GAZPROM_CACHE_FILE):
            try:
                with open(GAZPROM_CACHE_FILE, 'r', encoding='utf-8') as f:
                    return f.read(), True
            except:
                pass
        return json.dumps({"error": str(e)}), False

class MyHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def get_user_from_token(self):
        auth_header = self.headers.get('Authorization')
        if not auth_header or not auth_header.startswith('Bearer '):
            return None
        token = auth_header.split(' ')[1]
        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=['HS256'])
            return payload
        except:
            return None

    def send_json(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-type', 'application/json')
        self.end_headers()
        
        class CustomEncoder(json.JSONEncoder):
            def default(self, obj):
                if isinstance(obj, (datetime.datetime, datetime.date)):
                    return obj.isoformat()
                import uuid
                if isinstance(obj, uuid.UUID):
                    return str(obj)
                return super().default(obj)
                
        self.wfile.write(json.dumps(data, cls=CustomEncoder).encode('utf-8'))


    def do_POST(self):
        parsed_path = urlparse(self.path)
        content_length = int(self.headers.get('Content-Length', 0))
        post_data = self.rfile.read(content_length)
        
        try:
            params = json.loads(post_data.decode('utf-8')) if post_data else {}
        except:
            self.send_error(400, "Invalid JSON")
            return

        # AUTH: REGISTER
        if parsed_path.path == '/api/auth/register':
            email = params.get('email')
            password = params.get('password')
            if not email or not password:
                return self.send_json({"error": "Missing email or password"}, 400)
            
            try:
                conn = get_db_connection()
                cursor = conn.cursor()
                cursor.execute("INSERT INTO users (email, password_hash) VALUES (%s, %s) RETURNING id",
                             (email, generate_password_hash(password, method='pbkdf2:sha256')))

                user_id = cursor.fetchone()[0]
                conn.commit()
                cursor.close()
                conn.close()
                return self.send_json({"status": "ok", "user_id": str(user_id)})
            except psycopg2.IntegrityError:
                return self.send_json({"error": "User already exists"}, 400)
            except Exception as e:
                return self.send_json({"error": str(e)}, 500)

        # AUTH: LOGIN
        elif parsed_path.path == '/api/auth/login':
            email = params.get('email')
            password = params.get('password')
            try:
                conn = get_db_connection()
                cursor = conn.cursor(cursor_factory=RealDictCursor)
                cursor.execute("SELECT id, email, password_hash, is_admin FROM users WHERE email = %s", (email,))

                user = cursor.fetchone()
                cursor.close()
                conn.close()

                if user and check_password_hash(user['password_hash'], password):
                    token = jwt.encode({
                        'id': str(user['id']),
                        'email': user['email'],
                        'is_admin': user.get('is_admin', False),
                        'exp': datetime.datetime.utcnow() + datetime.timedelta(days=30)
                    }, SECRET_KEY, algorithm='HS256')
                    return self.send_json({"token": token, "user": {"id": str(user['id']), "email": user['email'], "is_admin": user.get('is_admin', False)}})

                else:
                    return self.send_json({"error": "Invalid credentials"}, 401)
            except Exception as e:
                return self.send_json({"error": str(e)}, 500)

        # COMMENTS
        elif parsed_path.path == '/api/comments':
            user = self.get_user_from_token()
            station_id = str(params.get('station_id'))
            text = params.get('text')
            date = params.get('date')
            author_email = user['email'] if user else params.get('author_email', 'Аноним')
            user_id = user['id'] if user else None
            
            if not station_id or not text:
                return self.send_error(400, "Missing fields")
                
            try:
                conn = get_db_connection()
                cursor = conn.cursor()
                cursor.execute('INSERT INTO comments (station_id, text, date, author_email, user_id) VALUES (%s, %s, %s, %s, %s)',
                             (station_id, text, date, author_email, user_id))
                conn.commit()
                cursor.close()
                conn.close()
                return self.send_json({"status": "ok"})
            except Exception as e:
                return self.send_json({"error": str(e)}, 500)

        # FAVORITES
        elif parsed_path.path == '/api/favorites':
            user = self.get_user_from_token()
            if not user: return self.send_json({"error": "Unauthorized"}, 401)
            
            station_id = str(params.get('station_id'))
            action = params.get('action') # 'add' or 'remove'
            
            try:
                conn = get_db_connection()
                cursor = conn.cursor()
                if action == 'add':
                    cursor.execute('INSERT INTO favorites (user_id, station_id) VALUES (%s, %s) ON CONFLICT DO NOTHING', 
                                 (user['id'], station_id))
                else:
                    cursor.execute('DELETE FROM favorites WHERE user_id = %s AND station_id = %s', 
                                 (user['id'], station_id))
                conn.commit()
                cursor.close()
                conn.close()
                return self.send_json({"status": "ok"})
            except Exception as e:
                return self.send_json({"error": str(e)}, 500)

        # SAVED ROUTES
        elif parsed_path.path == '/api/saved_routes':
            user = self.get_user_from_token()
            if not user: return self.send_json({"error": "Unauthorized"}, 401)
            
            try:
                conn = get_db_connection()
                cursor = conn.cursor(cursor_factory=RealDictCursor)
                cursor.execute('''
                    INSERT INTO saved_routes (user_id, name, origin_name, dest_name, origin_coords, dest_coords, waypoints)
                    VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING *
                ''', (user['id'], params.get('name'), params.get('origin_name'), params.get('dest_name'),
                     params.get('origin_coords'), params.get('dest_coords'), json.dumps(params.get('waypoints'))))
                route = cursor.fetchone()
                route['id'] = str(route['id'])
                route['user_id'] = str(route['user_id'])
                conn.commit()
                cursor.close()
                conn.close()
                return self.send_json(route)
            except Exception as e:
                print(f"Error saving route: {e}")
                return self.send_json({"error": str(e)}, 500)


        # ERROR REPORTS
        elif parsed_path.path == '/api/error_reports':
            user = self.get_user_from_token()
            try:
                conn = get_db_connection()
                cursor = conn.cursor()
                cursor.execute('''
                    INSERT INTO error_reports (station_id, error_type, description, user_id, author_email)
                    VALUES (%s, %s, %s, %s, %s)
                ''', (params.get('station_id'), params.get('error_type'), params.get('description'),
                     user['id'] if user else None, user['email'] if user else params.get('author_email')))
                conn.commit()
                cursor.close()
                conn.close()
                return self.send_json({"status": "ok"})
            except Exception as e:
                return self.send_json({"error": str(e)}, 500)

        elif parsed_path.path.startswith('/api/admin/users/toggle_admin/'):
            user = self.get_user_from_token()
            if not user or not user.get('is_admin'): return self.send_json({"error": "Forbidden"}, 403)
            target_id = parsed_path.path.split('/')[-1]
            try:
                conn = get_db_connection()
                cursor = conn.cursor()
                cursor.execute('UPDATE users SET is_admin = NOT is_admin WHERE id = %s', (target_id,))
                conn.commit()
                cursor.close()
                conn.close()
                return self.send_json({"status": "ok"})
            except Exception as e:
                return self.send_json({"error": str(e)}, 500)

        elif parsed_path.path.startswith('/api/admin/error_reports/status/'):
            user = self.get_user_from_token()
            if not user or not user.get('is_admin'): return self.send_json({"error": "Forbidden"}, 403)
            report_id = parsed_path.path.split('/')[-1]
            status = params.get('status')
            try:
                conn = get_db_connection()
                cursor = conn.cursor()
                cursor.execute('UPDATE error_reports SET status = %s WHERE id = %s', (status, report_id))
                conn.commit()
                cursor.close()
                conn.close()
                return self.send_json({"status": "ok"})
            except Exception as e:
                return self.send_json({"error": str(e)}, 500)
        else:
            self.send_error(404)


    def do_GET(self):
        parsed_path = urlparse(self.path)
        
        # AUTH: ME
        if parsed_path.path == '/api/auth/me':
            user = self.get_user_from_token()
            if user:
                return self.send_json({"user": user})
            else:
                return self.send_json({"error": "Unauthorized"}, 401)

        elif parsed_path.path == '/api/gazprom_stations':
            data, success = fetch_gazprom_data()
            self.send_response(200 if success else 500)
            self.send_header('Content-type', 'application/json')
            self.send_header('Cache-Control', f'max-age={GAZPROM_CACHE_TTL}')
            self.end_headers()
            self.wfile.write(data.encode('utf-8'))

        elif parsed_path.path == '/config.js':
            # Динамически отдаем конфигурацию из переменных окружения
            maps_key = os.environ.get('YANDEX_MAPS_API_KEY', '')
            suggest_key = os.environ.get('YANDEX_SUGGEST_API_KEY', '')
            config_content = f"const CONFIG = {{ YANDEX_MAPS_API_KEY: '{maps_key}', YANDEX_SUGGEST_API_KEY: '{suggest_key}' }};"
            self.send_response(200)
            self.send_header('Content-type', 'application/javascript')
            self.end_headers()
            self.wfile.write(config_content.encode('utf-8'))

            
        elif parsed_path.path == '/api/comments':
            query = parse_qs(parsed_path.query)
            station_id = query.get('station_id', [None])[0]
            
            try:
                conn = get_db_connection()
                cursor = conn.cursor(cursor_factory=RealDictCursor)
                if station_id:
                    cursor.execute('SELECT id, station_id, text, date, author_email FROM comments WHERE station_id = %s ORDER BY created_at DESC', (station_id,))
                else:
                    cursor.execute('SELECT id, station_id, text, date, author_email FROM comments ORDER BY created_at DESC')
                
                comments = cursor.fetchall()
                for c in comments:
                    c['id'] = str(c['id'])
                cursor.close()
                conn.close()
                return self.send_json(comments)
            except Exception as e:
                return self.send_json({"error": str(e)}, 500)

        elif parsed_path.path == '/api/favorites':
            user = self.get_user_from_token()
            if not user: return self.send_json({"error": "Unauthorized"}, 401)
            
            try:
                conn = get_db_connection()
                cursor = conn.cursor()
                cursor.execute('SELECT station_id FROM favorites WHERE user_id = %s', (user['id'],))
                favs = [r[0] for r in cursor.fetchall()]
                cursor.close()
                conn.close()
                return self.send_json(favs)
            except Exception as e:
                return self.send_json({"error": str(e)}, 500)

        elif parsed_path.path == '/api/saved_routes':
            user = self.get_user_from_token()
            if not user: return self.send_json({"error": "Unauthorized"}, 401)
            
            try:
                conn = get_db_connection()
                cursor = conn.cursor(cursor_factory=RealDictCursor)
                cursor.execute('SELECT * FROM saved_routes WHERE user_id = %s ORDER BY created_at DESC', (user['id'],))
                routes = cursor.fetchall()
                for r in routes: 
                    r['id'] = str(r['id'])
                    r['user_id'] = str(r['user_id'])
                cursor.close()
                conn.close()
                return self.send_json(routes)
            except Exception as e:
                return self.send_json({"error": str(e)}, 500)

        elif parsed_path.path == '/api/suggest':
            query = parse_qs(parsed_path.query)
            text = query.get('text', [''])[0]
            if not text:
                self.send_error(400, "Missing text")
                return
            self.proxy_suggest(text)
            
        elif parsed_path.path == '/api/admin/users':
            user = self.get_user_from_token()
            if not user or not user.get('is_admin'): return self.send_json({"error": "Forbidden"}, 403)
            try:
                conn = get_db_connection()
                cursor = conn.cursor(cursor_factory=RealDictCursor)
                cursor.execute('SELECT id, email, is_admin, created_at FROM users ORDER BY created_at DESC')
                users = cursor.fetchall()
                cursor.close()
                conn.close()
                return self.send_json(users)
            except Exception as e:
                return self.send_json({"error": str(e)}, 500)

        elif parsed_path.path == '/api/admin/error_reports':

            user = self.get_user_from_token()
            if not user or not user.get('is_admin'):
                return self.send_json({"error": "Forbidden"}, 403)
            try:
                conn = get_db_connection()
                cursor = conn.cursor(cursor_factory=RealDictCursor)
                cursor.execute('SELECT * FROM error_reports ORDER BY created_at DESC')
                reports = cursor.fetchall()
                cursor.close()
                conn.close()
                return self.send_json(reports)
            except Exception as e:
                return self.send_json({"error": str(e)}, 500)

        elif parsed_path.path == '/api/admin/comments':
            user = self.get_user_from_token()
            if not user or not user.get('is_admin'):
                return self.send_json({"error": "Forbidden"}, 403)
            try:
                conn = get_db_connection()
                cursor = conn.cursor(cursor_factory=RealDictCursor)
                cursor.execute('SELECT * FROM comments ORDER BY created_at DESC')
                comments = cursor.fetchall()
                cursor.close()
                conn.close()
                return self.send_json(comments)
            except Exception as e:
                return self.send_json({"error": str(e)}, 500)

            
        else:
            super().do_GET()

    def do_DELETE(self):
        parsed_path = urlparse(self.path)
        user = self.get_user_from_token()
        if not user: return self.send_json({"error": "Unauthorized"}, 401)

        if parsed_path.path.startswith('/api/saved_routes/'):
            route_id = parsed_path.path.split('/')[-1]
            try:
                conn = get_db_connection()
                cursor = conn.cursor()
                cursor.execute('DELETE FROM saved_routes WHERE id = %s AND user_id = %s', (route_id, user['id']))
                conn.commit()
                cursor.close()
                conn.close()
                return self.send_json({"status": "ok"})
            except Exception as e:
                return self.send_json({"error": str(e)}, 500)
        elif parsed_path.path.startswith('/api/admin/comments/'):
            if not user or not user.get('is_admin'): return self.send_json({"error": "Forbidden"}, 403)
            comment_id = parsed_path.path.split('/')[-1]
            try:
                conn = get_db_connection()
                cursor = conn.cursor()
                cursor.execute('DELETE FROM comments WHERE id = %s', (comment_id,))
                conn.commit()
                cursor.close()
                conn.close()
                return self.send_json({"status": "ok"})
            except Exception as e:
                return self.send_json({"error": str(e)}, 500)

        elif parsed_path.path.startswith('/api/admin/error_reports/'):
            if not user or not user.get('is_admin'): return self.send_json({"error": "Forbidden"}, 403)
            report_id = parsed_path.path.split('/')[-1]
            try:
                conn = get_db_connection()
                cursor = conn.cursor()
                cursor.execute('DELETE FROM error_reports WHERE id = %s', (report_id,))
                conn.commit()
                cursor.close()
                conn.close()
                return self.send_json({"status": "ok"})
            except Exception as e:
                return self.send_json({"error": str(e)}, 500)
        elif parsed_path.path.startswith('/api/admin/users/'):
            if not user or not user.get('is_admin'): return self.send_json({"error": "Forbidden"}, 403)
            target_id = parsed_path.path.split('/')[-1]
            try:
                conn = get_db_connection()
                cursor = conn.cursor()
                cursor.execute('DELETE FROM users WHERE id = %s', (target_id,))
                conn.commit()
                cursor.close()
                conn.close()
                return self.send_json({"status": "ok"})
            except Exception as e:
                return self.send_json({"error": str(e)}, 500)
        else:
            self.send_error(404)



    def proxy_suggest(self, text):
        apikey = ''
        try:
            if os.path.exists('config.js'):
                with open('config.js', 'r', encoding='utf-8') as f:
                    content = f.read()
                    match = re.search(r"YANDEX_SUGGEST_API_KEY:\s*'([^']+)'", content)
                    if match: apikey = match.group(1)
        except: pass
        if not apikey: apikey = os.environ.get('YANDEX_SUGGEST_API_KEY', '')
        
        if not apikey:
            self.send_error(500, "Suggest key not found")
            return

        url = f"https://suggest-maps.yandex.ru/v1/suggest?apikey={apikey}&text={urllib.parse.quote(text)}&print_address=1"
        try:
            with urllib.request.urlopen(url) as response:
                data = response.read()
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(data)
        except Exception as e:
            self.send_error(500, str(e))

if __name__ == '__main__':
    init_db()
    
    def background_updater():
        while True:
            try: fetch_gazprom_data()
            except: pass
            time.sleep(GAZPROM_CACHE_TTL)

    threading.Thread(target=background_updater, daemon=True).start()
    
    server_port = int(os.environ.get('PORT', 8080))
    print(f"Server started on port {server_port}. Using PostgreSQL connection.")
    http.server.HTTPServer(('0.0.0.0', server_port), MyHandler).serve_forever()

