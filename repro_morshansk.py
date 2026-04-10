
import re

def clean_schedule_text(text):
    if not text:
        return ''
    
    # Разделяем на части по точке с запятой или новой строке
    segments = re.split(r'[;\n]', text)
    
    cleaned_segments = []
    for seg in segments:
        s = seg.strip()
        if not s:
            continue
            
        # 1. Проверяем, не является ли сегмент просто набором цифр (телефоном) или годом
        digits = re.sub(r'\D', '', s)
        # BUG: This was too aggressive
        if len(digits) >= 7 and ':' not in s and ' - ' not in s:
            print(f"[REMOVED as phone] {s} (digits: {len(digits)})")
            continue
            
        # Если сегмент — просто год вида «2021» — игнорируем
        if re.match(r'^\s*20\d{2}\s*$', s):
            continue
            
        # 2. Очищаем от известных префиксов
        s = re.sub(r'\b(?:тел|т|факс|газ|реализация газа)\.?\s*[:.\-]?\s*', '', s, flags=re.IGNORECASE)
        s = s.replace('()', '') # Пустые скобки
        s = s.strip()
        
        # 3. Убираем висячую пунктуацию и лишние пробелы
        s = re.sub(r'^[;,\s.\-\)]+|[;,\s.\-\(]+$', '', s)
        s = re.sub(r'\s+', ' ', s)
        
        if len(s) > 3 or re.search(r'24\/7|пн|вт|ср|чт|пт|сб|вс', s, re.IGNORECASE):
            cleaned_segments.append(s)
            
    return '; '.join(cleaned_segments) if cleaned_segments else text

morshansk_schedule = 'пн-пт: 5ч30м - 11ч00м; 12ч00м-13ч00м; 14ч00м-15ч00м; 17ч00м-22ч00м; сб-вс: 5ч30м - 11ч00м'
print('Original:', morshansk_schedule)
print('Cleaned: ', clean_schedule_text(morshansk_schedule))

# Test proposed fix logic
def clean_schedule_text_fixed(text):
    if not text:
        return ''
    segments = re.split(r'[;\n]', text)
    cleaned_segments = []
    for seg in segments:
        s = seg.strip()
        if not s: continue
        digits = re.sub(r'\D', '', s)
        # Fixed: allow if it has "-" (without spaces) AND letters like 'ч' or 'м' (common in time)
        # Or better: check if it matches a time range pattern
        is_time = re.search(r'\d{1,2}[ч:.]\d{2}', s) or (':' in s) or (' - ' in s)
        if len(digits) >= 7 and not is_time:
            print(f"[FIXED][REMOVED as phone] {s} (digits: {len(digits)})")
            continue
        # ... rest of the logic
        s = re.sub(r'\b(?:тел|т|факс|газ|реализация газа)\.?\s*[:.\-]?\s*', '', s, flags=re.IGNORECASE)
        s = s.strip()
        s = re.sub(r'^[;,\s.\-\)]+|[;,\s.\-\(]+$', '', s)
        s = re.sub(r'\s+', ' ', s)
        if len(s) > 3 or re.search(r'24\/7|пн|вт|ср|чт|пт|сб|вс', s, re.IGNORECASE):
            cleaned_segments.append(s)
    return '; '.join(cleaned_segments) if cleaned_segments else text

print('Fixed:   ', clean_schedule_text_fixed(morshansk_schedule))
