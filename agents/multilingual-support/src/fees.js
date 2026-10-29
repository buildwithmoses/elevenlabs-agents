// Late-cancellation fee, decided in code (the model got "4pm today to 9am tomorrow" wrong once).
// Input times are what the caller said, as day offsets from today plus 24h clock.
export const LATE_FEE = 40;

export function cancellationFee({ now_day_offset = 0, now_hour, now_minute = 0, appt_day_offset, appt_hour, appt_minute = 0 }) {
  const nums = [now_day_offset, now_hour, now_minute, appt_day_offset, appt_hour, appt_minute].map(Number);
  if (nums.some((n) => !Number.isFinite(n)) || now_hour < 0 || now_hour > 23 || appt_hour < 0 || appt_hour > 23) return { ok: false, error: 'need now_hour and appt_day_offset/appt_hour as numbers (24h clock)' };
  const [nd, nh, nm, ad, ah, am] = nums;
  const minutes = (ad - nd) * 1440 + (ah - nh) * 60 + (am - nm);
  if (minutes <= 0) return { ok: true, hours_notice: +(minutes / 60).toFixed(1), late: true, fee: LATE_FEE, note: 'The appointment time has passed or is now; this counts as a no-show or late cancellation.', waiver: 'The $40 fee is waived once per calendar year per patient. Front desk staff check whether the waiver was already used.' };
  const hours = +(minutes / 60).toFixed(1);
  const late = minutes < 24 * 60;
  return { ok: true, hours_notice: hours, late, fee: late ? LATE_FEE : 0,
    waiver: late ? 'The $40 fee is waived once per calendar year per patient. Front desk staff check whether the waiver was already used.' : null };
}
