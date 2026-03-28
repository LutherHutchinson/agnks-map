import http.server
import json
import os
from urllib.parse import urlparse, parse_qs

PORT = 8080
COMMENTS_FILE = 'user_comments.json'

class MyHandler(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path == '/api/comments':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            
            try:
                new_comment = json.loads(post_data.decode('utf-8'))
                station_id = str(new_comment.get('stationId'))
                text = new_comment.get('text', '').strip()
                
                if not station_id or not text:
                    self.send_error(400, "Missing stationId or text")
                    return

                # Load existing comments
                comments = {}
                if os.path.exists(COMMENTS_FILE):
                    with open(COMMENTS_FILE, 'r', encoding='utf-8') as f:
                        try:
                            comments = json.load(f)
                        except json.JSONDecodeError:
                            comments = {}

                # Add new comment
                if station_id not in comments:
                    comments[station_id] = []
                
                import datetime
                comments[station_id].append({
                    'text': text,
                    'date': datetime.datetime.now().strftime('%d.%m.%Y %H:%M')
                })

                # Save back to file
                with open(COMMENTS_FILE, 'w', encoding='utf-8') as f:
                    json.dump(comments, f, ensure_ascii=False, indent=4)

                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'status': 'success'}).encode('utf-8'))
                
            except Exception as e:
                self.send_error(500, str(e))
        else:
            self.send_error(404)

    def get_comments(self):
        import datetime
        comments = {}
        if os.path.exists(COMMENTS_FILE):
            try:
                with open(COMMENTS_FILE, 'r', encoding='utf-8') as f:
                    comments = json.load(f)
            except (json.JSONDecodeError, FileNotFoundError):
                return {}

        # Filter out comments older than 24 hours
        now = datetime.datetime.now()
        new_comments = {}
        changed = False
        
        for st_id, st_comments in comments.items():
            filtered = []
            for c in st_comments:
                try:
                    c_date = datetime.datetime.strptime(c['date'], '%d.%m.%Y %H:%M')
                    if now - c_date < datetime.timedelta(hours=24):
                        filtered.append(c)
                    else:
                        changed = True
                except:
                    changed = True # Remove malformed dates
                    continue
            if filtered:
                new_comments[st_id] = filtered
            else:
                changed = True # Key removed because all comments gone
        
        # Save cleaned comments back to file if anything was removed
        if changed:
            with open(COMMENTS_FILE, 'w', encoding='utf-8') as f:
                json.dump(new_comments, f, ensure_ascii=False, indent=4)
        
        return new_comments

    def do_GET(self):
        if self.path == '/api/comments':
            comments = self.get_comments()
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(comments).encode('utf-8'))
        else:
            # Default to static file serving
            super().do_GET()

if __name__ == '__main__':
    print(f"Starting server on port {PORT}...")
    server = http.server.HTTPServer(('', PORT), MyHandler)
    server.serve_forever()
