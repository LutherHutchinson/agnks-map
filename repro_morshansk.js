
function cleanScheduleText(text) {
    if (!text) return '';
    const segments = text.split(/[;\n]/);
    const cleanedSegments = segments.map(seg => {
        let s = seg.trim();
        if (!s) return '';
        const digits = s.replace(/\D/g, '');
        // BUG: This was too aggressive
        if (digits.length >= 7 && !s.includes(':') && !s.includes(' - ')) {
            console.log(`[REMOVED as phone] ${s} (digits: ${digits.length})`);
            return '';
        }
        if (/^\s*20\d{2}\s*$/.test(s)) return '';
        s = s.replace(/\b(?:тел|т|факс|газ|реализация газа)\.?\s*[:.\-]?\s*/gi, '')
            .replace(/\(\s*\)/g, '')
            .trim();
        s = s.replace(/^[;,\s.\-\)]+|[;,\s.\-\(]+$/g, '').replace(/\s+/g, ' ');
        return s;
    }).filter(s => s.length > 3 || /24\/7|пн|вт|ср|чт|пт|сб|вс/i.test(s));
    return cleanedSegments.join('; ') || text;
}

const morshanskSchedule = 'пн-пт: 5ч30м - 11ч00м; 12ч00м-13ч00м; 14ч00м-15ч00м; 17ч00м-22ч00м; сб-вс: 5ч30м - 11ч00м';
console.log('Original:', morshanskSchedule);
console.log('Cleaned: ', cleanScheduleText(morshanskSchedule));

// Verify if it works with spaces
console.log('Cleaned (with spaces):', cleanScheduleText('пн-пт: 5ч30м - 11ч00м; 12ч00м - 13ч00м'));
