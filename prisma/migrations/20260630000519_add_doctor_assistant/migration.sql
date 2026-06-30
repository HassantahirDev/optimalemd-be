-- CreateTable
CREATE TABLE "public"."doctor_assistants" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "linkedDoctorId" TEXT NOT NULL,
    "canCreate" BOOLEAN NOT NULL DEFAULT false,
    "canRead" BOOLEAN NOT NULL DEFAULT true,
    "canUpdate" BOOLEAN NOT NULL DEFAULT false,
    "canDelete" BOOLEAN NOT NULL DEFAULT false,
    "resetToken" TEXT,
    "resetTokenExpiry" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "doctor_assistants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "doctor_assistants_email_key" ON "public"."doctor_assistants"("email");

-- CreateIndex
CREATE INDEX "doctor_assistants_linkedDoctorId_idx" ON "public"."doctor_assistants"("linkedDoctorId");

-- AddForeignKey
ALTER TABLE "public"."doctor_assistants" ADD CONSTRAINT "doctor_assistants_linkedDoctorId_fkey" FOREIGN KEY ("linkedDoctorId") REFERENCES "public"."doctors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
