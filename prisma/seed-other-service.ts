import { PrismaClient } from '@prisma/client';

/**
 * Adds an "Other" medical service, for visits that don't fit the existing list
 * (medical marijuana enquiries among them).
 *
 * Services are normally created through the admin UI; this exists so the option
 * can be added consistently across environments. Idempotent — `Service.name` is
 * unique, so re-running only reactivates and leaves everything else alone.
 *
 *   npx ts-node prisma/seed-other-service.ts
 */
const prisma = new PrismaClient();

async function main() {
  // Mirror the shape of the existing consultation services so it behaves the
  // same in booking: duration drives slot length, basePrice drives the fee.
  const reference = await prisma.service.findFirst({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
    select: { category: true, duration: true, basePrice: true },
  });

  const service = await prisma.service.upsert({
    where: { name: 'Other' },
    update: { isActive: true },
    create: {
      name: 'Other',
      description: 'For concerns that do not fit the other services. Your provider will advise at the consultation.',
      category: reference?.category || 'Consultation',
      duration: reference?.duration ?? 30,
      basePrice: reference?.basePrice ?? 0,
      isActive: true,
    },
  });

  console.log(`"Other" service ready: ${service.id}`);
  console.log(`  category: ${service.category}  duration: ${service.duration}m  basePrice: ${service.basePrice}`);

  const doctors = await prisma.doctor.count({ where: { isActive: true } });
  const linked = await prisma.doctorService.count({ where: { serviceId: service.id } });
  console.log(`\nactive doctors: ${doctors}, doctors offering "Other": ${linked}`);
  if (linked === 0) {
    console.log('NOTE: no doctor offers this service yet, so no slots will show for it.');
    console.log('      Assign it to doctors in the admin panel (or via DoctorService) before it is bookable.');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
