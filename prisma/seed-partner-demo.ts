import { PrismaClient, CommissionType } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

// Demo credentials — change the password after first login (mustChangePassword=true
// makes the portal force a reset on first sign-in anyway).
const DEMO_PARTNER = {
  name: 'Demo Partner',
  email: 'demo-partner@formamd.com',
  password: 'Partner123!',
  companyName: 'Demo Gym & Wellness',
  referralCode: 'PARTNER-DEMO1',
};

async function main() {
  console.log('Seeding referral-partner demo data...');

  // ── 1. A global default commission rule so ANY partner earns something ──
  const existingRule = await prisma.commissionRule.findFirst({
    where: { partnerId: null, isActive: true },
  });
  if (existingRule) {
    console.log(`Global commission rule already exists: "${existingRule.name}" — skipping.`);
  } else {
    const rule = await prisma.commissionRule.create({
      data: {
        partnerId: null, // global default — applies to every partner without their own rule
        name: 'Standard flat $50',
        type: CommissionType.FLAT,
        flatAmountCents: 5000, // $50.00
        isActive: true,
      },
    });
    console.log(`Created global commission rule: "${rule.name}" ($50 flat per qualified referral)`);
  }

  // ── 2. A demo partner account you can log in with right away ──
  const existingPartner = await prisma.referralPartner.findUnique({ where: { email: DEMO_PARTNER.email } });
  if (existingPartner) {
    console.log(`Partner ${DEMO_PARTNER.email} already exists (code: ${existingPartner.referralCode}) — skipping.`);
  } else {
    const hashed = await bcrypt.hash(DEMO_PARTNER.password, 12);
    const partner = await prisma.referralPartner.create({
      data: {
        name: DEMO_PARTNER.name,
        email: DEMO_PARTNER.email,
        password: hashed,
        companyName: DEMO_PARTNER.companyName,
        referralCode: DEMO_PARTNER.referralCode,
        mustChangePassword: false, // demo account — skip the forced reset so you can test immediately
      },
    });
    console.log('Created demo partner:');
    console.log(`  Portal:   http://localhost:5173/partners-login  (or partners.formamd.com in prod)`);
    console.log(`  Email:    ${partner.email}`);
    console.log(`  Password: ${DEMO_PARTNER.password}`);
    console.log(`  Referral link: http://localhost:5173/?ref=${partner.referralCode}`);
  }

  console.log('Done.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
