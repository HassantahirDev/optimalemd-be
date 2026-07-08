/**
 * Seed script: Hormone Optimization / TRT  &  Sexual Health medications
 *
 * Run with:
 *   npx ts-node --project tsconfig.json prisma/seed-medications-hrt-sexual.ts
 *
 * This script:
 *  1. Deletes ALL existing medications in the "Hormone Optimization / TRT"
 *     and "Sexual Health" therapy categories.
 *  2. Creates the full set of clinical medications with all dosage variations,
 *     including the exact per-variation dosageInstruction string.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ─────────────────────────────────────────────────────────────────────────────
// Prescription templates (full clinical text stored per medication group)
// ─────────────────────────────────────────────────────────────────────────────

const TC_INJECTION_RX = `Men's Hormone Replacement Therapy
Hormone Replacement Therapy Treatment:
Patient to monitor and record weekly blood pressure and heart rate for review at follow up. If blood pressure is consistently >150/90 or there are any notable side effects or concerns such as lumps/tenderness in the testicles, severe acne, oily skin, difficulty urinating, thinning hair, worsening fatigue, breast enlargement or tenderness, increased moodiness, etc., patient is to discontinue use of testosterone therapy and follow up with their FormaMD-affiliated physician for further evaluation and treatment.
Follow up labs and telemedicine consult in approximately 3 months. Labs to be drawn as instructed in email to follow. Care team will arrange subsequent lab testing and follow ups. If follow up labs are abnormal, repeat labs per company protocol prior to follow up consultation.
Testosterone Cypionate (200mg/mL): Dispense one month supply with 3 refills and include injection supplies. Discussed with patient injection sites as well as injection methods. Ship directly to the patient's home address unless a local pharmacy is requested.
IM/SQ injections: If the patient is prescribed IM injections and would like to switch to SQ injections or if the patient is prescribed SQ injections and would like to switch to IM injections, our team will modify the patient's next prescription refill to reflect the appropriate needles and syringes per company protocol.
Testosterone Therapy: Reviewed mechanism of action and that through its use, there will be suppression of natural production of testosterone and semen (which may lead to infertility), and may lead to the shrinkage of the testicles. Also discussed that there are no guarantees that natural production of testosterone will return to baseline after stopping therapy. Discussion of the main side effects included: testicular shrinkage, infertility, acne, oily skin, hair loss, mood changes, breast development, deeper voice, hirsutism, lower HDL, stimulation of BPH/malignant prostate issues, elevation in red blood cell production, elevation in estrogen and need for an additional medication/supplement for inhibition.
Contraindications reviewed: known breast or prostate cancer, palpable prostate nodule, PSA >4 ng/mL without urologic evaluation, severe lower urinary tract symptoms, known hypersensitivity, untreated severe sleep apnea, uncontrolled or poorly controlled severe heart failure, active desire for fertility (unless combining therapy with clomiphene citrate), MI within the last 3-6 months. If the criteria for diagnosis of hypogonadism is not achieved (TT <300ng/dL), testosterone will be used "off label" for the symptomatic treatment of low testosterone.`;

const TC_TROCHE_RX = `Men's Hormone Replacement Therapy
Hormone Replacement Therapy Treatment:
Patient to monitor and record weekly blood pressure and heart rate for review at follow up. If blood pressure is consistently >150/90 or there are any notable side effects or concerns, patient is to discontinue use of testosterone therapy and follow up with their FormaMD-affiliated physician for further evaluation and treatment.
Follow up labs and telemedicine consult in approximately 3 months.
Testosterone Sublingual Troche: Dispense one month supply with 3 refills. Ship directly to the patient's home address.
Testosterone Therapy: Reviewed mechanism of action and that through its use, there will be suppression of natural production of testosterone and semen (which may lead to infertility), and may lead to the shrinkage of the testicles. Discussion of the main side effects included: testicular shrinkage, infertility, acne, oily skin, hair loss, mood changes, breast development, deeper voice, hirsutism, lower HDL, stimulation of BPH/malignant prostate issues, elevation in red blood cell production, elevation in estrogen and need for an additional medication/supplement for inhibition.
Contraindications reviewed: known breast or prostate cancer, palpable prostate nodule, PSA >4 ng/mL without urologic evaluation, severe lower urinary tract symptoms, known hypersensitivity, untreated severe sleep apnea, uncontrolled or poorly controlled severe heart failure, active desire for fertility, MI within the last 3-6 months.`;

const TC_CREAM_RX = `Men's Hormone Replacement Therapy
Hormone Replacement Therapy Treatment:
Patient to monitor and record weekly blood pressure and heart rate for review at follow up. If blood pressure is consistently >150/90 or there are any notable side effects, patient is to discontinue use and follow up with their FormaMD-affiliated physician.
Follow up labs and telemedicine consult in approximately 3 months.
Testosterone Cream: Apply 1 mL topically as directed by your physician — dispense one month supply with 3 refills. Application Instructions: apply directly to testicles, inner thighs or over the shoulders and cover with clothing; wash hands thoroughly after application or wear gloves (transference caution required). Ship directly to the patient's home address.
The application of testosterone cream using an ungloved hand may lead to abnormal lab results. Recommend testing at a lab using venipuncture. Labs should be drawn on the same day but prior to cream application.
Testosterone Therapy: Reviewed mechanism of action and main side effects including: testicular shrinkage, infertility, acne, oily skin, hair loss, mood changes, breast development, lower HDL, elevated estrogen.
Contraindications reviewed: known breast or prostate cancer, palpable prostate nodule, PSA >4 ng/mL without urologic evaluation, severe lower urinary tract symptoms, known hypersensitivity, untreated severe sleep apnea, uncontrolled severe heart failure, active desire for fertility, MI within the last 3-6 months.`;

const ENCLOMIPHENE_RX = `Hormone Restoration Therapy Treatment:
Patient educated that enclomiphene stimulates endogenous testosterone via hypothalamic-pituitary axis activation.
Follow-Up: Labs in 6–8 weeks (TT, FT, LH, FSH, estradiol, CBC, CMP). Telemedicine visit after labs for review.
Side Effects Discussed: Headache, visual changes, mood fluctuations, nausea, elevated estradiol, acne.
Contraindications Reviewed: Pregnancy, hormone-sensitive malignancies, hepatic impairment.
Off-Label Disclosure: Used off-label for treatment of functional secondary hypogonadism and fertility preservation.`;

const ANASTROZOLE_RX = `Estrogen Management Therapy:
Anastrozole (Arimidex) is used to manage elevated estrogen levels, typically as adjunct therapy to testosterone replacement.
Follow-Up: Labs in 6–8 weeks (estradiol, CBC, CMP, bone density baseline if long-term use anticipated). Telemedicine visit after labs for review.
Side Effects Discussed: Joint pain, arthralgia, bone density reduction with long-term use, hot flashes, fatigue, mood changes, elevated cholesterol.
Contraindications Reviewed: Severe osteoporosis, premenopausal use without close monitoring, hypersensitivity to anastrozole or excipients.`;

const SILDENAFIL_RX = `Sildenafil Therapy:
Sexual Health
Follow up labs and telemedicine consult in approximately 3 months. Labs to be drawn as instructed in email to follow. Care team will arrange subsequent lab testing and follow ups. If follow up labs are abnormal, repeat labs per company protocol prior to follow up consultation.
PDE5 Inhibitor Therapy: Reviewed mechanism of action and how the medication prolongs the effect of cGMP by inhibiting its degradation by the enzyme PDE5. In the penis, PDE5 inhibitors prolong erections and increase sexual satisfaction. Patient has been counseled that ED is a risk marker for underlying cardiovascular disease and other health conditions that may warrant further evaluation and treatment by his PCP. Consideration of the benefits of lifestyle modifications have been discussed. Discussion of potential side effects included (but are not limited to): back pain, cold-like symptoms, dizziness, flushing, headache, limb pain, indigestion, myalgia, priapism, tinnitus, vision changes.
Contraindications reviewed: hypotension or uncontrolled hypertension, heart failure, angina, MI within the past 90 days, stroke within the past 6 months, aortic stenosis, penile deformities, nitrate use or alpha blocker use, sickle cell disease, multiple myeloma, leukemia.
Potential at home treatments for priapism: Watch and wait, walking or jogging in place, applying ice packs and pressure on the perineum. If no contraindications, pseudoephedrine 60-120mg and diphenhydramine 25mg. If rescue efforts are ineffective and the erection has been present for 4 hours and/or is painful, the patient should immediately visit the ER for further evaluation and treatment.`;

const TADALAFIL_RX = `Tadalafil Therapy:
Sexual Health
Follow up labs and telemedicine consult in approximately 3 months. Labs to be drawn as instructed in email to follow. Care team will arrange subsequent lab testing and follow ups. If follow up labs are abnormal, repeat labs per company protocol prior to follow up consultation.
PDE5 Inhibitor Therapy: Reviewed mechanism of action and how the medication prolongs the effect of cGMP by inhibiting its degradation by the enzyme PDE5. In the penis, PDE5 inhibitors prolong erections and increase sexual satisfaction. Patient has been counseled that ED is a risk marker for underlying cardiovascular disease and other health conditions that may warrant further evaluation and treatment by his PCP. Consideration of the benefits of lifestyle modifications have been discussed. Discussion of potential side effects included (but are not limited to): back pain, cold-like symptoms, dizziness, flushing, headache, limb pain, indigestion, myalgia, priapism, tinnitus, vision changes.
Contraindications reviewed: hypotension or uncontrolled hypertension, heart failure, angina, MI within the past 90 days, stroke within the past 6 months, aortic stenosis, penile deformities, nitrate use or alpha blocker use, sickle cell disease, multiple myeloma, leukemia.
Potential at home treatments for priapism: Watch and wait, walking or jogging in place, applying ice packs and pressure on the perineum. If no contraindications, pseudoephedrine 60-120mg and diphenhydramine 25mg. If rescue efforts are ineffective and the erection has been present for 4 hours and/or is painful, the patient should immediately visit the ER for further evaluation and treatment.`;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function med(overrides: {
  name: string;
  therapyCategory: string;
  strength?: string;
  dose?: string;
  frequency?: string;
  route?: string;
  directions?: string;
  dosageInstruction?: string;
  standardPrice: number;
  prescription?: string;
}) {
  return {
    name: overrides.name,
    therapyCategory: overrides.therapyCategory,
    categoryName: overrides.therapyCategory,
    strength: overrides.strength ?? null,
    dose: overrides.dose ?? null,
    frequency: overrides.frequency ?? null,
    route: overrides.route ?? null,
    directions: overrides.directions ?? null,
    dosageInstruction: overrides.dosageInstruction ?? null,
    standardPrice: overrides.standardPrice,
    price: overrides.standardPrice, // legacy required field — keep in sync
    prescription: overrides.prescription ?? null,
    isActive: true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const CATEGORIES = ['Hormone Optimization / TRT', 'Sexual Health'];

  console.log(`\nDeleting existing medications for: ${CATEGORIES.join(', ')}...`);
  const deleted = await prisma.medication.deleteMany({
    where: { therapyCategory: { in: CATEGORIES } },
  });
  console.log(`Deleted ${deleted.count} existing records.\n`);

  // ── 1. Testosterone Cypionate Injection ──────────────────────────────────
  // 51 variations: IM (23) + SQ (28)
  const tcName = 'Testosterone Cypionate Injection';
  const tcCat  = 'Hormone Optimization / TRT';
  const tcStr  = '200mg/mL';
  const tcPrice = 30;

  type TcVariant = {
    dose: string;
    frequency: string;
    route: string;
    directions?: string;
    dosageInstruction: string;
  };

  const tcVariants: TcVariant[] = [
    // ── IM · Twice weekly (higher doses, same-days instruction) ──
    {
      dose: '0.625 mL (125 mg)', frequency: 'Twice weekly', route: 'Intramuscular injection',
      directions: 'Inject on same days each week',
      dosageInstruction: 'Inject 0.625 mL (125 mg) intramuscularly twice weekly on same days each week',
    },
    {
      dose: '0.75 mL (150 mg)', frequency: 'Twice weekly', route: 'Intramuscular injection',
      directions: 'Inject on same days each week',
      dosageInstruction: 'Inject 0.75 mL (150 mg) intramuscularly twice weekly on same days each week',
    },
    {
      dose: '0.875 mL (175 mg)', frequency: 'Twice weekly', route: 'Intramuscular injection',
      directions: 'Inject on same days each week',
      dosageInstruction: 'Inject 0.875 mL (175 mg) intramuscularly twice weekly on same days each week',
    },
    {
      dose: '1 mL (200 mg)', frequency: 'Twice weekly', route: 'Intramuscular injection',
      directions: 'Inject on same days each week',
      dosageInstruction: 'Inject 1 mL (200 mg) intramuscularly twice weekly on same days each week',
    },
    // ── IM · Three times weekly ──
    {
      dose: '0.2 mL (40 mg)', frequency: 'Three times weekly', route: 'Intramuscular injection',
      directions: 'Inject on same days each week',
      dosageInstruction: 'Inject 0.2 mL (40 mg) intramuscularly three times weekly on same days each week',
    },
    {
      dose: '0.25 mL (50 mg)', frequency: 'Three times weekly', route: 'Intramuscular injection',
      directions: 'Inject on same days each week',
      dosageInstruction: 'Inject 0.25 mL (50 mg) intramuscularly three times weekly on same days each week',
    },
    {
      dose: '0.3 mL (60 mg)', frequency: 'Three times weekly', route: 'Intramuscular injection',
      directions: 'Inject on same days each week',
      dosageInstruction: 'Inject 0.3 mL (60 mg) intramuscularly three times weekly on same days each week',
    },
    // ── IM · Four times weekly ──
    {
      dose: '0.1 mL (20 mg)', frequency: 'Four times weekly', route: 'Intramuscular injection',
      directions: 'Inject on same days each week',
      dosageInstruction: 'Inject 0.1 mL (20 mg) intramuscularly four times weekly on same days each week',
    },
    {
      dose: '0.15 mL (30 mg)', frequency: 'Four times weekly', route: 'Intramuscular injection',
      directions: 'Inject on same days each week',
      dosageInstruction: 'Inject 0.15 mL (30 mg) intramuscularly four times weekly on same days each week',
    },
    {
      dose: '0.2 mL (40 mg)', frequency: 'Four times weekly', route: 'Intramuscular injection',
      directions: 'Inject on same days each week',
      dosageInstruction: 'Inject 0.2 mL (40 mg) intramuscularly four times weekly on same days each week',
    },
    {
      dose: '0.25 mL (50 mg)', frequency: 'Four times weekly', route: 'Intramuscular injection',
      directions: 'Inject on same days each week',
      dosageInstruction: 'Inject 0.25 mL (50 mg) intramuscularly four times weekly on same days each week',
    },
    // ── IM · Once weekly ──
    {
      dose: '0.7 mL (140 mg)', frequency: 'Once weekly', route: 'Intramuscular injection',
      dosageInstruction: 'Inject 0.7 mL (140 mg) intramuscularly once weekly',
    },
    {
      dose: '0.75 mL (150 mg)', frequency: 'Once weekly', route: 'Intramuscular injection',
      dosageInstruction: 'Inject 0.75 mL (150 mg) intramuscularly once weekly',
    },
    {
      dose: '0.8 mL (160 mg)', frequency: 'Once weekly', route: 'Intramuscular injection',
      dosageInstruction: 'Inject 0.8 mL (160 mg) intramuscularly once weekly',
    },
    {
      dose: '0.9 mL (180 mg)', frequency: 'Once weekly', route: 'Intramuscular injection',
      dosageInstruction: 'Inject 0.9 mL (180 mg) intramuscularly once weekly',
    },
    {
      dose: '1 mL (200 mg)', frequency: 'Once weekly', route: 'Intramuscular injection',
      dosageInstruction: 'Inject 1 mL (200 mg) intramuscularly once weekly',
    },
    // ── IM · Twice weekly (standard doses) ──
    {
      dose: '0.25 mL (50 mg)', frequency: 'Twice weekly', route: 'Intramuscular injection',
      dosageInstruction: 'Inject 0.25 mL (50 mg) intramuscularly twice weekly on same days each week',
    },
    {
      dose: '0.3 mL (60 mg)', frequency: 'Twice weekly', route: 'Intramuscular injection',
      dosageInstruction: 'Inject 0.3 mL (60 mg) intramuscularly twice weekly on same days each week',
    },
    {
      dose: '0.375 mL (75 mg)', frequency: 'Twice weekly', route: 'Intramuscular injection',
      dosageInstruction: 'Inject 0.375 mL (75 mg) intramuscularly twice weekly on same days each week',
    },
    {
      dose: '0.4 mL (80 mg)', frequency: 'Twice weekly', route: 'Intramuscular injection',
      dosageInstruction: 'Inject 0.4 mL (80 mg) intramuscularly twice weekly on same days each week',
    },
    {
      dose: '0.45 mL (90 mg)', frequency: 'Twice weekly', route: 'Intramuscular injection',
      dosageInstruction: 'Inject 0.45 mL (90 mg) intramuscularly twice weekly on same days each week',
    },
    {
      dose: '0.5 mL (100 mg)', frequency: 'Twice weekly', route: 'Intramuscular injection',
      dosageInstruction: 'Inject 0.5 mL (100 mg) intramuscularly twice weekly on same days each week',
    },
    {
      dose: '0.6 mL (120 mg)', frequency: 'Twice weekly', route: 'Intramuscular injection',
      dosageInstruction: 'Inject 0.6 mL (120 mg) intramuscularly twice weekly on same days each week',
    },
    // ── SQ · Three times weekly ──
    {
      dose: '0.25 mL (50 mg)', frequency: 'Three times weekly', route: 'Subcutaneous injection',
      dosageInstruction: 'Inject 0.25 mL (50 mg) subcutaneously three times weekly on same days each week',
    },
    {
      dose: '0.3 mL (60 mg)', frequency: 'Three times weekly', route: 'Subcutaneous injection',
      dosageInstruction: 'Inject 0.3 mL (60 mg) subcutaneously three times weekly on same days each week',
    },
    {
      dose: '0.4 mL (80 mg)', frequency: 'Three times weekly', route: 'Subcutaneous injection',
      dosageInstruction: 'Inject 0.4 mL (80 mg) subcutaneously three times weekly on same days each week',
    },
    {
      dose: '0.5 mL (100 mg)', frequency: 'Three times weekly', route: 'Subcutaneous injection',
      dosageInstruction: 'Inject 0.5 mL (100 mg) subcutaneously three times weekly on same days each week',
    },
    // ── SQ · Four times weekly ──
    {
      dose: '0.1 mL (20 mg)', frequency: 'Four times weekly', route: 'Subcutaneous injection',
      dosageInstruction: 'Inject 0.1 mL (20 mg) subcutaneously four times weekly on same days each week',
    },
    {
      dose: '0.15 mL (30 mg)', frequency: 'Four times weekly', route: 'Subcutaneous injection',
      dosageInstruction: 'Inject 0.15 mL (30 mg) subcutaneously four times weekly on same days each week',
    },
    {
      dose: '0.2 mL (40 mg)', frequency: 'Four times weekly', route: 'Subcutaneous injection',
      dosageInstruction: 'Inject 0.2 mL (40 mg) subcutaneously four times weekly on same days each week',
    },
    {
      dose: '0.25 mL (50 mg)', frequency: 'Four times weekly', route: 'Subcutaneous injection',
      dosageInstruction: 'Inject 0.25 mL (50 mg) subcutaneously four times weekly on same days each week',
    },
    // ── SQ · Twice weekly ──
    {
      dose: '0.25 mL (50 mg)', frequency: 'Twice weekly', route: 'Subcutaneous injection',
      dosageInstruction: 'Inject 0.25 mL (50 mg) subcutaneously twice weekly on same days each week',
    },
    {
      dose: '0.3 mL (60 mg)', frequency: 'Twice weekly', route: 'Subcutaneous injection',
      dosageInstruction: 'Inject 0.3 mL (60 mg) subcutaneously twice weekly on same days each week',
    },
    {
      dose: '0.375 mL (75 mg)', frequency: 'Twice weekly', route: 'Subcutaneous injection',
      dosageInstruction: 'Inject 0.375 mL (75 mg) subcutaneously twice weekly on same days each week',
    },
    {
      dose: '0.4 mL (80 mg)', frequency: 'Twice weekly', route: 'Subcutaneous injection',
      dosageInstruction: 'Inject 0.4 mL (80 mg) subcutaneously twice weekly on same days each week',
    },
    {
      dose: '0.45 mL (90 mg)', frequency: 'Twice weekly', route: 'Subcutaneous injection',
      dosageInstruction: 'Inject 0.45 mL (90 mg) subcutaneously twice weekly on same days each week',
    },
    {
      dose: '0.5 mL (100 mg)', frequency: 'Twice weekly', route: 'Subcutaneous injection',
      dosageInstruction: 'Inject 0.5 mL (100 mg) subcutaneously twice weekly on same days each week',
    },
    {
      dose: '0.6 mL (120 mg)', frequency: 'Twice weekly', route: 'Subcutaneous injection',
      dosageInstruction: 'Inject 0.6 mL (120 mg) subcutaneously twice weekly on same days each week',
    },
    {
      dose: '0.625 mL (125 mg)', frequency: 'Twice weekly', route: 'Subcutaneous injection',
      dosageInstruction: 'Inject 0.625 mL (125 mg) subcutaneously twice weekly on same days each week',
    },
    {
      dose: '0.75 mL (150 mg)', frequency: 'Twice weekly', route: 'Subcutaneous injection',
      dosageInstruction: 'Inject 0.75 mL (150 mg) subcutaneously twice weekly on same days each week',
    },
    {
      dose: '0.875 mL (175 mg)', frequency: 'Twice weekly', route: 'Subcutaneous injection',
      dosageInstruction: 'Inject 0.875 mL (175 mg) subcutaneously twice weekly on same days each week',
    },
    {
      dose: '1 mL (200 mg)', frequency: 'Twice weekly', route: 'Subcutaneous injection',
      dosageInstruction: 'Inject 1 mL (200 mg) subcutaneously twice weekly on same days each week',
    },
    // ── SQ · Once weekly ──
    {
      dose: '0.25 mL (50 mg)', frequency: 'Once weekly', route: 'Subcutaneous injection',
      dosageInstruction: 'Inject 0.25 mL (50 mg) subcutaneously once weekly',
    },
    {
      dose: '0.4 mL (80 mg)', frequency: 'Once weekly', route: 'Subcutaneous injection',
      dosageInstruction: 'Inject 0.4 mL (80 mg) subcutaneously once weekly',
    },
    {
      dose: '0.5 mL (100 mg)', frequency: 'Once weekly', route: 'Subcutaneous injection',
      dosageInstruction: 'Inject 0.5 mL (100 mg) subcutaneously once weekly',
    },
    {
      dose: '0.6 mL (120 mg)', frequency: 'Once weekly', route: 'Subcutaneous injection',
      dosageInstruction: 'Inject 0.6 mL (120 mg) subcutaneously once weekly',
    },
    {
      dose: '0.7 mL (140 mg)', frequency: 'Once weekly', route: 'Subcutaneous injection',
      dosageInstruction: 'Inject 0.7 mL (140 mg) subcutaneously once weekly',
    },
    {
      dose: '0.75 mL (150 mg)', frequency: 'Once weekly', route: 'Subcutaneous injection',
      dosageInstruction: 'Inject 0.75 mL (150 mg) subcutaneously once weekly',
    },
    {
      dose: '0.8 mL (160 mg)', frequency: 'Once weekly', route: 'Subcutaneous injection',
      dosageInstruction: 'Inject 0.8 mL (160 mg) subcutaneously once weekly',
    },
    {
      dose: '0.9 mL (180 mg)', frequency: 'Once weekly', route: 'Subcutaneous injection',
      dosageInstruction: 'Inject 0.9 mL (180 mg) subcutaneously once weekly',
    },
    {
      dose: '1 mL (200 mg)', frequency: 'Once weekly', route: 'Subcutaneous injection',
      dosageInstruction: 'Inject 1 mL (200 mg) subcutaneously once weekly',
    },
  ];

  await prisma.medication.createMany({
    data: tcVariants.map(v =>
      med({
        name: tcName,
        therapyCategory: tcCat,
        strength: tcStr,
        dose: v.dose,
        frequency: v.frequency,
        route: v.route,
        directions: v.directions,
        dosageInstruction: v.dosageInstruction,
        standardPrice: tcPrice,
        prescription: TC_INJECTION_RX,
      }),
    ),
  });
  console.log(`✓ Testosterone Cypionate Injection — ${tcVariants.length} variations`);

  // ── 2. Testosterone Troche ───────────────────────────────────────────────
  const trocheName = 'Testosterone Troche';
  const trochePrescription = TC_TROCHE_RX;
  const trocheCat = 'Hormone Optimization / TRT';

  type TrocheVariant = { strength: string; frequency: string; directions: string; dosageInstruction: string };
  const trocheVariants: TrocheVariant[] = [
    {
      strength: '50mg', frequency: 'Twice per week',
      directions: 'Take sublingually (suck, do not chew)',
      dosageInstruction: 'Take one troche (50 mg) sublingually (suck, do not chew) twice per week',
    },
    {
      strength: '50mg', frequency: 'Three times per week',
      directions: 'Take sublingually (suck, do not chew)',
      dosageInstruction: 'Take one troche (50 mg) sublingually (suck, do not chew) three times per week',
    },
    {
      strength: '50mg', frequency: 'Once daily',
      directions: 'Take sublingually (suck, do not chew)',
      dosageInstruction: 'Take one troche (50 mg) sublingually (suck, do not chew) once daily',
    },
    {
      strength: '50mg', frequency: 'Twice daily',
      directions: 'Take sublingually (suck, do not chew) 8–10 hours apart',
      dosageInstruction: 'Take one troche (50 mg) sublingually (suck, do not chew) twice daily, 8–10 hours apart',
    },
    {
      strength: '100mg', frequency: 'Twice per week',
      directions: 'Take sublingually (suck, do not chew)',
      dosageInstruction: 'Take one troche (100 mg) sublingually (suck, do not chew) twice per week',
    },
    {
      strength: '100mg', frequency: 'Three times per week',
      directions: 'Take sublingually (suck, do not chew)',
      dosageInstruction: 'Take one troche (100 mg) sublingually (suck, do not chew) three times per week',
    },
    {
      strength: '100mg', frequency: 'Once daily',
      directions: 'Take sublingually (suck, do not chew)',
      dosageInstruction: 'Take one troche (100 mg) sublingually (suck, do not chew) once daily',
    },
    {
      strength: '100mg', frequency: 'Twice daily',
      directions: 'Take sublingually (suck, do not chew) 8–10 hours apart',
      dosageInstruction: 'Take one troche (100 mg) sublingually (suck, do not chew) twice daily, 8–10 hours apart',
    },
  ];

  await prisma.medication.createMany({
    data: trocheVariants.map(v =>
      med({
        name: trocheName,
        therapyCategory: trocheCat,
        strength: v.strength,
        dose: '1 tablet',
        frequency: v.frequency,
        route: 'Sublingual',
        directions: v.directions,
        dosageInstruction: v.dosageInstruction,
        standardPrice: 60,
        prescription: trochePrescription,
      }),
    ),
  });
  console.log(`✓ Testosterone Troche — ${trocheVariants.length} variations`);

  // ── 3. Testosterone Cream ────────────────────────────────────────────────
  type CreamVariant = { strength: string; frequency: string; dosageInstruction: string };
  const creamVariants: CreamVariant[] = [
    {
      strength: '56mg/mL', frequency: 'Once daily',
      dosageInstruction: 'Apply 1 mL (56 mg) topically once daily as directed by your physician',
    },
    {
      strength: '112mg/mL', frequency: 'Once daily',
      dosageInstruction: 'Apply 1 mL (112 mg) topically once daily as directed by your physician',
    },
    {
      strength: '178mg/mL', frequency: 'Once daily',
      dosageInstruction: 'Apply 1 mL (178 mg) topically once daily as directed by your physician',
    },
    {
      strength: '56mg/mL', frequency: 'Twice daily',
      dosageInstruction: 'Apply 1 mL (56 mg) topically twice daily as directed by your physician',
    },
    {
      strength: '112mg/mL', frequency: 'Twice daily',
      dosageInstruction: 'Apply 1 mL (112 mg) topically twice daily as directed by your physician',
    },
    {
      strength: '178mg/mL', frequency: 'Twice daily',
      dosageInstruction: 'Apply 1 mL (178 mg) topically twice daily as directed by your physician',
    },
  ];

  await prisma.medication.createMany({
    data: creamVariants.map(v =>
      med({
        name: 'Testosterone Cream',
        therapyCategory: 'Hormone Optimization / TRT',
        strength: v.strength,
        dose: '1 mL',
        frequency: v.frequency,
        route: 'Topical',
        directions: 'Apply topically as directed by your physician. Apply to testicles, inner thighs, or over the shoulders. Wash hands thoroughly after application or wear gloves.',
        dosageInstruction: v.dosageInstruction,
        standardPrice: 60,
        prescription: TC_CREAM_RX,
      }),
    ),
  });
  console.log(`✓ Testosterone Cream — ${creamVariants.length} variations`);

  // ── 4. Enclomiphene ──────────────────────────────────────────────────────
  type EnclomipheneVariant = { strength: string; frequency: string; dosageInstruction: string };
  const enclomipheneVariants: EnclomipheneVariant[] = [
    {
      strength: '12.5mg', frequency: 'Once daily',
      dosageInstruction: 'Take 1 capsule (12.5 mg) orally once daily',
    },
    {
      strength: '12.5mg', frequency: 'Every other day',
      dosageInstruction: 'Take 1 capsule (12.5 mg) orally every other day',
    },
    {
      strength: '12.5mg', frequency: 'Three times weekly',
      dosageInstruction: 'Take 1 capsule (12.5 mg) orally three times weekly',
    },
    {
      strength: '12.5mg', frequency: 'Twice weekly',
      dosageInstruction: 'Take 1 capsule (12.5 mg) orally twice weekly',
    },
    {
      strength: '12.5mg', frequency: 'Once weekly',
      dosageInstruction: 'Take 1 capsule (12.5 mg) orally once weekly',
    },
    {
      strength: '25mg', frequency: 'Once daily',
      dosageInstruction: 'Take 1 capsule (25 mg) orally once daily',
    },
    {
      strength: '25mg', frequency: 'Every other day',
      dosageInstruction: 'Take 1 capsule (25 mg) orally every other day',
    },
    {
      strength: '25mg', frequency: 'Three times weekly',
      dosageInstruction: 'Take 1 capsule (25 mg) orally three times weekly',
    },
    {
      strength: '25mg', frequency: 'Twice weekly',
      dosageInstruction: 'Take 1 capsule (25 mg) orally twice weekly',
    },
    {
      strength: '25mg', frequency: 'Once weekly',
      dosageInstruction: 'Take 1 capsule (25 mg) orally once weekly',
    },
  ];

  await prisma.medication.createMany({
    data: enclomipheneVariants.map(v =>
      med({
        name: 'Enclomiphene',
        therapyCategory: 'Hormone Optimization / TRT',
        strength: v.strength,
        dose: '1 capsule',
        frequency: v.frequency,
        route: 'Oral',
        dosageInstruction: v.dosageInstruction,
        standardPrice: 40,
        prescription: ENCLOMIPHENE_RX,
      }),
    ),
  });
  console.log(`✓ Enclomiphene — ${enclomipheneVariants.length} variations`);

  // ── 5. Anastrozole (Arimidex) ────────────────────────────────────────────
  type AnastrozoleVariant = { dose: string; frequency: string; dosageInstruction: string };
  const anastrozoleVariants: AnastrozoleVariant[] = [
    {
      dose: '½ tablet (0.5mg)', frequency: 'Once every other week',
      dosageInstruction: 'Take ½ tablet (0.5 mg) orally once every other week',
    },
    {
      dose: '½ tablet (0.5mg)', frequency: 'Once weekly',
      dosageInstruction: 'Take ½ tablet (0.5 mg) orally once weekly',
    },
    {
      dose: '½ tablet (0.5mg)', frequency: 'Twice weekly',
      dosageInstruction: 'Take ½ tablet (0.5 mg) orally twice weekly',
    },
    {
      dose: '½ tablet (0.5mg)', frequency: 'Three times weekly',
      dosageInstruction: 'Take ½ tablet (0.5 mg) orally three times weekly',
    },
    {
      dose: '½ tablet (0.5mg)', frequency: 'Every other day',
      dosageInstruction: 'Take ½ tablet (0.5 mg) orally every other day',
    },
    {
      dose: '½ tablet (0.5mg)', frequency: 'Monday–Friday (5 days weekly)',
      dosageInstruction: 'Take ½ tablet (0.5 mg) orally Monday through Friday (5 days weekly)',
    },
    {
      dose: '½ tablet (0.5mg)', frequency: 'Once daily',
      dosageInstruction: 'Take ½ tablet (0.5 mg) orally once daily',
    },
    {
      dose: '1 tablet (1mg)', frequency: 'Once every other week',
      dosageInstruction: 'Take 1 tablet (1 mg) orally once every other week',
    },
    {
      dose: '1 tablet (1mg)', frequency: 'Once weekly',
      dosageInstruction: 'Take 1 tablet (1 mg) orally once weekly',
    },
    {
      dose: '1 tablet (1mg)', frequency: 'Twice weekly',
      dosageInstruction: 'Take 1 tablet (1 mg) orally twice weekly',
    },
    {
      dose: '1 tablet (1mg)', frequency: 'Three times weekly',
      dosageInstruction: 'Take 1 tablet (1 mg) orally three times weekly',
    },
    {
      dose: '1 tablet (1mg)', frequency: 'Every other day',
      dosageInstruction: 'Take 1 tablet (1 mg) orally every other day',
    },
    {
      dose: '1 tablet (1mg)', frequency: 'Monday–Friday (5 days weekly)',
      dosageInstruction: 'Take 1 tablet (1 mg) orally Monday through Friday (5 days weekly)',
    },
    {
      dose: '1 tablet (1mg)', frequency: 'Once daily',
      dosageInstruction: 'Take 1 tablet (1 mg) orally once daily',
    },
  ];

  await prisma.medication.createMany({
    data: anastrozoleVariants.map(v =>
      med({
        name: 'Anastrozole (Arimidex)',
        therapyCategory: 'Hormone Optimization / TRT',
        strength: '1mg tablet',
        dose: v.dose,
        frequency: v.frequency,
        route: 'Oral',
        dosageInstruction: v.dosageInstruction,
        standardPrice: 22,
        prescription: ANASTROZOLE_RX,
      }),
    ),
  });
  console.log(`✓ Anastrozole (Arimidex) — ${anastrozoleVariants.length} variations`);

  // ── 6. Sildenafil (generic Viagra) — Performance ─────────────────────────
  const sildVariants = [
    {
      strength: '50mg',
      directions: 'Take 60 min prior to intimacy on an empty stomach',
      dosageInstruction: 'Take 1 tablet (50 mg) orally 60 minutes prior to intimacy on an empty stomach',
    },
    {
      strength: '100mg',
      directions: 'Take 60 min prior to intimacy on an empty stomach',
      dosageInstruction: 'Take 1 tablet (100 mg) orally 60 minutes prior to intimacy on an empty stomach',
    },
  ];

  await prisma.medication.createMany({
    data: sildVariants.map(v =>
      med({
        name: 'Sildenafil (generic Viagra)',
        therapyCategory: 'Sexual Health',
        strength: v.strength,
        dose: '1 tablet',
        frequency: 'As needed',
        route: 'Oral',
        directions: v.directions,
        dosageInstruction: v.dosageInstruction,
        standardPrice: 35,
        prescription: SILDENAFIL_RX,
      }),
    ),
  });
  console.log(`✓ Sildenafil (generic Viagra) — ${sildVariants.length} variations`);

  // ── 7. Tadalafil Combination (generic Cialis) ────────────────────────────
  await prisma.medication.create({
    data: med({
      name: 'Tadalafil Combination (generic Cialis)',
      therapyCategory: 'Sexual Health',
      strength: '5mg',
      dose: '1 tablet',
      frequency: 'Once daily',
      route: 'Oral',
      directions: 'May increase to 4 total on day of intimacy',
      dosageInstruction: 'Take 1 tablet (5 mg) orally once daily; may increase to 4 tablets total on day of intimacy',
      standardPrice: 50,
      prescription: TADALAFIL_RX,
    }),
  });
  console.log('✓ Tadalafil Combination (generic Cialis) — 1 variation');

  // ── 8. Tadalafil Performance (generic Cialis) ────────────────────────────
  const tadalPerfVariants = [
    {
      strength: '10mg',
      directions: '1-2 hrs prior to intimacy. 1 tablet max daily dose.',
      dosageInstruction: 'Take 1 tablet (10 mg) orally 1–2 hours prior to intimacy; maximum 1 tablet per day',
    },
    {
      strength: '20mg',
      directions: '1-2 hrs prior to intimacy. 1 tablet max daily dose.',
      dosageInstruction: 'Take 1 tablet (20 mg) orally 1–2 hours prior to intimacy; maximum 1 tablet per day',
    },
  ];

  await prisma.medication.createMany({
    data: tadalPerfVariants.map(v =>
      med({
        name: 'Tadalafil Performance (generic Cialis)',
        therapyCategory: 'Sexual Health',
        strength: v.strength,
        dose: '1 tablet',
        frequency: 'As needed',
        route: 'Oral',
        directions: v.directions,
        dosageInstruction: v.dosageInstruction,
        standardPrice: 35,
        prescription: TADALAFIL_RX,
      }),
    ),
  });
  console.log(`✓ Tadalafil Performance (generic Cialis) — ${tadalPerfVariants.length} variations`);

  // ── 9. Tadalafil Protective (generic Cialis) ─────────────────────────────
  const tadalProtVariants = [
    {
      strength: '2.5mg',
      dosageInstruction: 'Take 1 tablet (2.5 mg) orally once daily',
    },
    {
      strength: '5mg',
      dosageInstruction: 'Take 1 tablet (5 mg) orally once daily',
    },
  ];

  await prisma.medication.createMany({
    data: tadalProtVariants.map(v =>
      med({
        name: 'Tadalafil Protective (generic Cialis)',
        therapyCategory: 'Sexual Health',
        strength: v.strength,
        dose: '1 tablet',
        frequency: 'Once daily',
        route: 'Oral',
        dosageInstruction: v.dosageInstruction,
        standardPrice: 40,
        prescription: TADALAFIL_RX,
      }),
    ),
  });
  console.log(`✓ Tadalafil Protective (generic Cialis) — ${tadalProtVariants.length} variations`);

  // ── Summary ──────────────────────────────────────────────────────────────
  const total =
    tcVariants.length +
    trocheVariants.length +
    creamVariants.length +
    enclomipheneVariants.length +
    anastrozoleVariants.length +
    sildVariants.length +
    1 + // Tadalafil Combination
    tadalPerfVariants.length +
    tadalProtVariants.length;

  console.log(`\n✅ Done — ${total} medication records created across both categories.\n`);
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
