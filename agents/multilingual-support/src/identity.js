// Identity rules for account tools. Pure functions, imported by tools.mjs and the tests.
// A caller is verified only when BOTH full name and date of birth match one patient record.

const strip = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd')
  .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// Names match regardless of accents, case and word order ("Nguyễn Văn Thành" == "thanh van nguyen").
export function sameName(a, b) {
  const x = strip(a).split(' ').filter(Boolean).sort().join(' ');
  const y = strip(b).split(' ').filter(Boolean).sort().join(' ');
  return x.length > 0 && x === y;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  ene: 1, abr: 4, ago: 8, dic: 12 };

// Accepts 1981-03-14, 03/14/1981, 14/03/1981 (when unambiguous), "March 14 1981", "14 de marzo de 1981".
export function normalizeDob(input) {
  const s = strip(input);
  let m = s.match(/^(\d{4}) (\d{1,2}) (\d{1,2})$/);
  if (m) return fmt(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2}) (\d{1,2}) (\d{4})$/);
  if (m) {
    const a = +m[1], b = +m[2], y = +m[3];
    if (a > 12) return fmt(y, b, a);           // day first
    return fmt(y, a, b);                        // US month first
  }
  const words = s.replace(/\bde\b|\bthang\b|\bngay\b|\bnam\b/g, ' ').replace(/\s+/g, ' ').trim();
  const mon = Object.entries(MONTHS).find(([k]) => new RegExp(`\\b${k}[a-z]*`).test(words));
  const nums = words.match(/\d+/g)?.map(Number) ?? [];
  const year = nums.find((n) => n > 1900);
  if (mon && year) { const day = nums.find((n) => n >= 1 && n <= 31 && n !== year); if (day) return fmt(year, mon[1], day); }
  // Vietnamese "ngày 2 tháng 11 năm 1958" -> after stripping: "2 11 1958" (day month year)
  if (nums.length === 3 && year === nums[2]) return fmt(nums[2], nums[1], nums[0]);
  return null;
}
function fmt(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function verify(patients, fullName, dob) {
  const d = normalizeDob(dob);
  if (!d || !fullName) return { verified: false, reason: 'need_full_name_and_date_of_birth' };
  const p = patients.find((x) => sameName(x.full_name, fullName) && x.date_of_birth === d);
  return p ? { verified: true, patient_id: p.patient_id } : { verified: false, reason: 'no_match' };
}
