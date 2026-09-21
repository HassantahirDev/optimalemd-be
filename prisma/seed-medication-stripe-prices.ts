import { PrismaClient } from '@prisma/client';

/**
 * Seeds `Medication.stripePriceId` from the reviewed mapping.
 *
 * One default Stripe price per medicine NAME — every catalogue row sharing that
 * name (Omega 3 has four dose variations, Finasteride six) gets the same default,
 * and the doctor adjusts the amount per prescription when the dose differs.
 *
 * Idempotent: re-running it just rewrites the same values. Medicines mapped to
 * null are deliberately unmapped — there is no suitable Stripe price, so the
 * doctor types the amount by hand.
 *
 *   npx ts-node prisma/seed-medication-stripe-prices.ts
 */
const prisma = new PrismaClient();

const MAPPING: Record<string, string | null> = {
  'Anastrozole (Arimidex)': 'price_1UAbJDIqcNoCEMxMT0W3Rv7K',
  'CJC/Ipamorelin (injectable)': 'price_1Scsc7IqcNoCEMxMQxVWTELy',
  'DHEA E4M': 'price_1TrUofIqcNoCEMxMAP0cGqPY',
  'Dutasteride Oral Therapy': 'price_1TaMguIqcNoCEMxMh4cszi7i',
  'Enclomiphene': 'price_1T9yuuIqcNoCEMxM1kxinspH',
  'Finasteride Oral Therapy': 'price_1TstBbIqcNoCEMxMUSoxy3BG',
  'GHK-Cu': 'price_1TDWS3IqcNoCEMxMcqiFy7Zv',
  'HCG 10,000 IU Vial': null,
  'Minoxidil Oral Therapy': 'price_1TstBbIqcNoCEMxMG1UkkAce',
  'MOTS-c': 'price_1TIG4kIqcNoCEMxMUSWkHkKY',
  'Omega 3 Fatty Acids': 'price_1SopfzIqcNoCEMxM65i7PcrE',
  'Pregnenolone E4M Capsule': null,
  'Prescription Grade Multivitamin': 'price_1T0TNWIqcNoCEMxMJu4A2Lmw',
  'Retatrutide': 'price_1UAbJDIqcNoCEMxMRQoe26LL',
  'Selank': 'price_1Tn2QdIqcNoCEMxMF52tYszH',
  'Semaglutide': 'price_1TUXD8IqcNoCEMxMdN773zbq',
  'Semax': 'price_1SsZzyIqcNoCEMxMsaKkaWOD',
  'Sermorelin': 'price_1SFhvqIqcNoCEMxMm79woMDV',
  'Sildenafil (generic Viagra)': null,
  'Tadalafil Combination Therapy': 'price_1SFhkCIqcNoCEMxMA2ajxsbw',
  'Tadalafil Performance (generic Cialis)': 'price_1SFhkCIqcNoCEMxMA2ajxsbw',
  'Tadalafil Protective (generic Cialis)': 'price_1SFhkCIqcNoCEMxMA2ajxsbw',
  'Tesamorelin': 'price_1SFf9oIqcNoCEMxMrlwCm3jt',
  'Testosterone Cream': 'price_1SdHoaIqcNoCEMxM9fJgGpv8',
  'Testosterone Cypionate Injection': 'price_1TUVSRIqcNoCEMxMK7nM4Gzm',
  // Shares the $60/month "Testosterone Cream monthly" price — confirmed, since the
  // amount is right. The Stripe product name is still a cream, so a troche invoice
  // line reads "Cream" until a troche product exists in Stripe.
  'Testosterone Troche': 'price_1SdHoaIqcNoCEMxM9fJgGpv8',
  'Tirzepatide': null,
  'Wolverine Blend (BPC-157/TB-500)': null,
};

/**
 * The same medicine is named differently between catalogues — formaMD_test calls
 * it "Finasteride pill" where the reviewed mapping says "Finasteride Oral
 * Therapy". Each alias inherits its canonical entry's price, so one seed covers
 * every environment and an unknown alias is simply reported as not found.
 */
const ALIASES: Record<string, string> = {
  'Finasteride pill': 'Finasteride Oral Therapy',
  'Oral Minoxidil': 'Minoxidil Oral Therapy',
  'Semaglutide (injectable)': 'Semaglutide',
  'Sermorelin (injectable)': 'Sermorelin',
  'Tadalafil Combination (generic Cialis)': 'Tadalafil Combination Therapy',
  'Tirzepatide (injectable)': 'Tirzepatide',
};

async function main() {
  let updated = 0;
  let missing = 0;
  const unmapped: string[] = [];

  const resolved: Array<[string, string | null]> = [
    ...Object.entries(MAPPING),
    ...Object.entries(ALIASES).map(
      ([alias, canonical]) => [alias, MAPPING[canonical] ?? null] as [string, string | null],
    ),
  ];

  for (const [name, priceId] of resolved) {
    const res = await prisma.medication.updateMany({
      where: { name },
      data: { stripePriceId: priceId },
    });
    if (res.count === 0) {
      missing++;
      console.warn(`  no catalogue rows named "${name}" — skipped`);
    } else {
      updated += res.count;
      if (priceId === null) unmapped.push(name);
      console.log(`  ${priceId ? priceId : '(unmapped)'.padEnd(30)}  ${res.count} row(s)  ${name}`);
    }
  }

  const total = await prisma.medication.count();
  const linked = await prisma.medication.count({ where: { stripePriceId: { not: null } } });
  console.log(`\nrows updated: ${updated}`);
  console.log(`medicine names not found in the catalogue: ${missing}`);
  console.log(`deliberately unmapped: ${unmapped.length}${unmapped.length ? ' → ' + unmapped.join(', ') : ''}`);
  console.log(`catalogue rows with a Stripe price: ${linked} of ${total}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
