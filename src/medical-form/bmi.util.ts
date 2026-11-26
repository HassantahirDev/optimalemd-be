/**
 * One BMI calculation for every place that saves or reads height/weight.
 * Heights and weights are free text ("5'10\"", "5 ft 10 in", "70in", "178cm",
 * "180", "180 lbs", "82kg"), so they are parsed before calculating.
 */

/** Height text → total inches, or null when it can't be read. */
export function parseHeightToInches(height?: string | null): number | null {
  if (!height) return null;
  const s = String(height).trim().toLowerCase();
  if (!s) return null;

  // Feet + inches: 5'10", 5' 10", 5ft10in, 5 ft 10 in, 5 feet 10 inches
  const ftIn = s.match(/^(\d+(?:\.\d+)?)\s*(?:ft|feet|foot|'|′)\s*(\d+(?:\.\d+)?)\s*(?:in|inches|inch|"|″)?$/);
  if (ftIn) return parseFloat(ftIn[1]) * 12 + parseFloat(ftIn[2]);

  // Feet only: 5ft, 5'
  const ftOnly = s.match(/^(\d+(?:\.\d+)?)\s*(?:ft|feet|foot|'|′)$/);
  if (ftOnly) return parseFloat(ftOnly[1]) * 12;

  // Centimeters: 178cm, 178 cm
  const cm = s.match(/^(\d+(?:\.\d+)?)\s*cm$/);
  if (cm) return parseFloat(cm[1]) / 2.54;

  // Inches, with or without a unit: 70in, 70", 70
  const inches = s.match(/^(\d+(?:\.\d+)?)\s*(?:in|inches|inch|"|″)?$/);
  if (inches) return parseFloat(inches[1]);

  return null;
}

/** Weight text → pounds, or null when it can't be read. A bare number is pounds. */
export function parseWeightToLbs(weight?: string | null): number | null {
  if (!weight) return null;
  const s = String(weight).trim().toLowerCase();

  const kg = s.match(/^(\d+(?:\.\d+)?)\s*(?:kg|kgs|kilograms?)$/);
  if (kg) return parseFloat(kg[1]) * 2.20462;

  const lbs = s.match(/^(\d+(?:\.\d+)?)\s*(?:lbs?|pounds?)?$/);
  if (lbs) return parseFloat(lbs[1]);

  return null;
}

/**
 * BMI to one decimal ("24.5"), or null when height/weight are missing or the
 * result is outside any human range (a typo such as height "5" read as 5 inches).
 */
export function calculateBmi(height?: string | null, weight?: string | null): string | null {
  const inches = parseHeightToInches(height);
  const lbs = parseWeightToLbs(weight);
  if (!inches || !lbs) return null;
  const bmi = (lbs / (inches * inches)) * 703;
  if (!Number.isFinite(bmi) || bmi < 8 || bmi > 120) return null;
  return bmi.toFixed(1);
}

/**
 * For a write: when height or weight is being saved, set `bmi` from the values
 * the form will end up with (the incoming ones, else what's already stored).
 * A height/weight the parser can't read leaves the BMI blank instead of stale.
 */
export function withCalculatedBmi<T extends Record<string, any>>(
  data: T,
  existing?: { height?: string | null; weight?: string | null } | null,
): T {
  if (!data || (!('height' in data) && !('weight' in data))) return data;
  const height = 'height' in data ? data.height : existing?.height;
  const weight = 'weight' in data ? data.weight : existing?.weight;
  return { ...data, bmi: calculateBmi(height, weight) };
}
