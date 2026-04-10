
const dayMap = {
    'пн': 1, 'вт': 2, 'ср': 3, 'чт': 4, 'пт': 5, 'сб': 6, 'вс': 0,
    'будни': [1, 2, 3, 4, 5], 'выходн': [6, 0], 'ежедневно': [0, 1, 2, 3, 4, 5, 6]
};

function testSchedule(scheduleText, timeStr, dayOfWeek) {
    let schedule = scheduleText.toLowerCase();

    // Fix candidate:
    schedule = schedule.replace(/без\s+выходных/g, 'ежедневно');
    // Original code had .replace(/выходны[ех]/g, 'выходн')
    schedule = schedule.replace(/выходны[ех]/g, 'выходн');

    console.log(`Testing: "${scheduleText}" at ${timeStr} (Day: ${dayOfWeek})`);
    console.log(`Normalized: "${schedule}"`);

    const segments = schedule.split(/[;\n]\s*/);
    let workingIntervals = [];

    segments.forEach(seg => {
        let segDays = [];
        let hasDayMarker = false;

        // Day tokens
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

        if (!hasDayMarker) {
            segDays = [0, 1, 2, 3, 4, 5, 6];
            hasDayMarker = true;
        }

        if (segDays.includes(dayOfWeek)) {
            const cleanSeg = seg.trim();
            const simpleRegex = /\b(\d{1,2})(?:[:](\d{2})|[.](\d{2})|[ ]([0-5]\d))?\s*(?:-|—|–|−|\s+(?:до|по)\s+)\s*(\d{1,2})(?:[:](\d{2})|[.](\d{2})|[ ]([0-5]\d))?\b/g;
            let timeFound = false;

            let simpleM;
            while ((simpleM = simpleRegex.exec(cleanSeg)) !== null) {
                const sh = parseInt(simpleM[1]);
                const sm = parseInt(simpleM[2] || simpleM[3] || simpleM[4] || '0');
                const eh = parseInt(simpleM[5]);
                const em = parseInt(simpleM[6] || simpleM[7] || simpleM[8] || '0');
                if (sh > 24 || sm > 59 || eh > 24 || em > 59) continue;
                timeFound = true;
                workingIntervals.push({ start: sh * 60 + sm, end: eh * 60 + em });
            }

            if (!timeFound) {
                const timeRegex = /(?:с\s*)?(\d{1,2})(?:\s*[:.ч]\s*(\d{1,2}))?\s*(?:мин|м)?\s*(?:-|—|–|−|по|до|и)\s*(?:до\s*)?(\d{1,2})(?:\s*[:.ч]\s*(\d{1,2}))?\s*(?:мин|м)?/gi;
                let m;
                while ((m = timeRegex.exec(cleanSeg)) !== null) {
                    const startH = parseInt(m[1]);
                    const startM = m[2] ? parseInt(m[2]) : 0;
                    const endH = parseInt(m[3]);
                    const endM = m[4] ? parseInt(m[4]) : 0;
                    if (startH > 24 || startM > 59 || endH > 24 || endM > 59) continue;
                    timeFound = true;
                    workingIntervals.push({ start: startH * 60 + startM, end: endH * 60 + endM });
                }
            }
        }
    });

    const [h, m] = timeStr.split(':').map(Number);
    const absMins = h * 60 + m;

    let isOpen = false;
    for (const w of workingIntervals) {
        if (absMins >= w.start && absMins < w.end) isOpen = true;
    }

    console.log(`Result: ${isOpen ? 'OPEN' : 'CLOSED'} (Intervals: ${JSON.stringify(workingIntervals)})`);
    console.log('---');
}

// Reproduction of the issue (Wednesday = 3)
testSchedule('с 8 00 - 20 00 без выходных', '13:48', 3);
testSchedule('8:00 - 20:00 без выходных', '11:48', 3);
