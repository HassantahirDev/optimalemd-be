import { PrismaService } from '../prisma/prisma.service';

/**
 * Attaches guest supplements purchases to a patient account by email.
 *
 * Guest checkout stores only an email. Whenever we know which account owns that
 * email — at checkout (account already exists), when the patient opens their
 * billing history or the store (e.g. they signed up after buying), or when staff
 * view orders — the order and its ledger row are linked to the account so they
 * sit in that patient's billing for good.
 *
 * Scoped to supplements records only, never touches rows already linked to
 * someone, and never throws (linking is a convenience, not part of the payment).
 * Returns how many orders were linked.
 */
export async function linkGuestSupplementPurchases(
  prisma: PrismaService,
  userId: string,
  emails: (string | null | undefined)[],
): Promise<number> {
  const list = Array.from(new Set(emails.filter(Boolean).map((e) => (e as string).trim().toLowerCase())));
  if (!userId || list.length === 0) return 0;
  try {
    const [orders] = await prisma.$transaction([
      prisma.supplementOrder.updateMany({
        where: { userId: null, email: { in: list } },
        data: { userId },
      }),
      prisma.paymentRecord.updateMany({
        where: { userId: null, category: 'SUPPLEMENT', billingEmail: { in: list } },
        data: { userId },
      }),
    ]);
    return orders.count;
  } catch {
    return 0;
  }
}

/** Finds the patient account (if any) that owns this email. */
export async function findUserIdByEmail(prisma: PrismaService, email: string): Promise<string | null> {
  const e = email.trim();
  if (!e) return null;
  const user = await prisma.user.findFirst({
    where: {
      OR: [
        { primaryEmail: { equals: e, mode: 'insensitive' } },
        { email: { equals: e, mode: 'insensitive' } },
      ],
    },
    select: { id: true },
  });
  return user?.id ?? null;
}
