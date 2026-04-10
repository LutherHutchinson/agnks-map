
function getRussiaTimeOffset(lon) {
    if (lon < 22.5) return 2;   // Калининград
    if (lon < 45.0) return 3;   // Москва
    if (lon < 53.0) return 4;   // Самара
    if (lon < 69.5) return 5;   // Екатеринбург
    return 6;
}

function getStationStatus(p, stationTime) {
    const absMins = (stationTime.getUTCHours() * 60) + stationTime.getUTCMinutes();

    let schedule = p.scheduleClean ? p.scheduleClean.toLowerCase() : '';
    console.log("Original schedule:", schedule);
    const isAlways = /круглосуточно|24\s*\/?\s*7|24\s*[чh]/i.test(schedule);
    if (!schedule) return 'no_data';

    // Normalization
    schedule = schedule
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
        .replace(/(\d{1,2})\s*утра/gi, '$1:00')
        .replace(/(\d{1,2})(?::(\d{2}))?\s*вечера/gi, (match, h, m) => {
            let hour = parseInt(h);
            const min = m || '00';
            if (hour < 12) hour += 12;
            return hour + ':' + min;
        })
        .replace(/(\d{1,2})\s*-\s*(\d{1,2})\s*ч/gi, '$1:00-$2:00')
        .replace(/(\d{1,2})\s*ч(?!\d)/gi, '$1:00')
        .replace(/\s+и\s+до\b/gi, '-');

    console.log("Normalized schedule:", schedule);

    const segments = schedule.split(/[;\n]\s*/);
    let workingIntervals = [];
    let breakIntervals = [];
    let explicitlyClosedToday = false;
    let hasAnyWorkDayData = false;

    const dayMap = {
        'пн': 1, 'вт': 2, 'ср': 3, 'чт': 4, 'пт': 5, 'сб': 6, 'вс': 0,
        'будни': [1, 2, 3, 4, 5], 'выходн': [6, 0], 'ежедневно': [0, 1, 2, 3, 4, 5, 6]
    };

    const dayToday = stationTime.getUTCDay();

    segments.forEach(seg => {
        if (!seg.trim()) return;
        let segDays = [];
        let hasDayMarker = false;

        const rangeMatches = seg.matchAll(/(пн|вт|ср|чт|пт|сб|вс)\s*(?:-|—|–|−)\s*(пн|вт|ср|чт|пт|сб|вс)/g);
        for (const m of rangeMatches) {
            hasDayMarker = true;
            let start = dayMap[m[1]], end = dayMap[m[2]];
            let s = start === 0 ? 7 : start, e = end === 0 ? 7 : end;
            if (s > e) [s, e] = [e, s];
            for (let i = s; i <= e; i++) segDays.push(i % 7);
        }

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

            const simpleRegex = /(\d{1,2})(?:[:](\d{2})|[.](\d{2}))?\s*(?:-|—|–|−|\s+(?:до|по)\s+)\s*(\d{1,2})(?:[:](\d{2})|[.](\d{2}))?/g;
            let simpleM;
            while ((simpleM = simpleRegex.exec(cleanSeg)) !== null) {
                const sh = parseInt(simpleM[1]);
                const sm = parseInt(simpleM[2] || simpleM[3] || '0');
                const eh = parseInt(simpleM[4]);
                const em = parseInt(simpleM[5] || simpleM[6] || '0');
                if (sh > 24 || sm > 59 || eh > 24 || em > 59) continue;
                if (sh === eh && sm === em) continue;
                timeFound = true;
                const interval = { start: sh * 60 + sm, end: eh * 60 + em };
                if (isBreak && !isGasSale) breakIntervals.push(interval);
                else { workingIntervals.push(interval); hasAnyWorkDayData = true; }
            }

            if (!timeFound) {
                while ((m = timeRegex.exec(cleanSeg)) !== null) {
                    const startH = parseInt(m[1]);
                    const startM = m[2] ? parseInt(m[2]) : 0;
                    const endH = parseInt(m[3]);
                    const endM = m[4] ? parseInt(m[4]) : 0;
                    timeFound = true;
                    const interval = { start: startH * 60 + startM, end: endH * 60 + endM };
                    if (isBreak && !isGasSale) breakIntervals.push(interval);
                    else { workingIntervals.push(interval); hasAnyWorkDayData = true; }
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

    console.log("Working Intervals:", workingIntervals);

    if (workingIntervals.length > 0) {
        for (const w of workingIntervals) {
            if (w.end > w.start) {
                if (absMins >= w.start && absMins < w.end) return 'open';
            } else {
                if (absMins >= w.start || absMins < w.end) return 'open';
            }
        }
        return 'closed';
    }
    if (isAlways) return 'open';
    if (explicitlyClosedToday) return 'closed';
    if (hasAnyWorkDayData) return 'closed';
    return 'no_data';
}

const nowStr = "2026-04-05T01:18:00+03:00"; // 01:18 AM UTC+3
const now = new Date(nowStr);

console.log("--- TEST: Песчано-Коледино (8 00 - 20 00) ---");
const p1 = { scheduleClean: "с 8 00 - 20 00 без выходных" };
const offset1 = getRussiaTimeOffset(62.8); // +5 (Ekaterinburg)
const time1 = new Date(now.getTime() + (offset1 * 3600000));
console.log("Station Time (UTC):", time1.toUTCString());
console.log("Result:", getStationStatus(p1, time1));

console.log("\n--- TEST: Карталы (Phone number matching schedule) ---");
const p2 = { scheduleClean: "т. (35133) 6-72-64" };
const offset2 = getRussiaTimeOffset(60.7); // +5
const time2 = new Date(now.getTime() + (offset2 * 3600000));
console.log("Result:", getStationStatus(p2, time2));
