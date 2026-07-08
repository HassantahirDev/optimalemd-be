import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../mailer/mailer.service';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

@Injectable()
export class UploadsService {
  private readonly uploadsDir: string;

  constructor(
    private prisma: PrismaService,
    private mailerService: MailerService,
  ) {
    // Create uploads directory at project root
    this.uploadsDir = path.join(process.cwd(), 'uploads', 'user-documents');
    
    // Ensure uploads directory exists
    if (!fs.existsSync(this.uploadsDir)) {
      fs.mkdirSync(this.uploadsDir, { recursive: true });
    }
  }

  async uploadDrivingLicense(userId: string, file: any): Promise<{ filePath: string; fileName: string }> {
    // Validate file
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    // Validate file type (images and PDFs)
    const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf'];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      throw new BadRequestException('Invalid file type. Please upload an image (JPEG, PNG, WebP) or PDF.');
    }

    // Validate file size (max 5MB)
    const maxSize = 5 * 1024 * 1024; // 5MB
    if (file.size > maxSize) {
      throw new BadRequestException('File size exceeds 5MB limit.');
    }

    // Check if user exists
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Generate unique filename
    const fileExtension = path.extname(file.originalname);
    const uniqueId = crypto.randomBytes(8).toString('hex');
    const fileName = `driving-license-${userId}-${uniqueId}${fileExtension}`;
    const filePath = path.join(this.uploadsDir, fileName);

    // Save file
    fs.writeFileSync(filePath, file.buffer);

    // Delete old file if exists
    if (user.drivingLicensePath && fs.existsSync(user.drivingLicensePath)) {
      try {
        fs.unlinkSync(user.drivingLicensePath);
      } catch (error) {
        console.error('Error deleting old driving license:', error);
      }
    }

    // Update user record
    await this.prisma.user.update({
      where: { id: userId },
      data: { drivingLicensePath: filePath },
    });

    return { filePath, fileName };
  }

  async uploadLabOrder(orderId: string, file: any): Promise<{ filePath: string; fileName: string }> {
    // Validate file
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    // Validate file type (images and PDFs)
    const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf'];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      throw new BadRequestException('Invalid file type. Please upload an image (JPEG, PNG, WebP) or PDF.');
    }

    // Validate file size (max 10MB)
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (file.size > maxSize) {
      throw new BadRequestException('File size exceeds 10MB limit.');
    }

    // Check if lab order exists with patient info
    const labOrder = await this.prisma.labOrder.findUnique({
      where: { id: orderId },
      include: {
        patient: true,
        items: {
          include: {
            labTestType: true,
          },
        },
      },
    });

    if (!labOrder) {
      throw new NotFoundException('Lab order not found');
    }

    // Generate unique filename
    const fileExtension = path.extname(file.originalname);
    const uniqueId = crypto.randomBytes(8).toString('hex');
    const fileName = `lab-order-${orderId}-${uniqueId}${fileExtension}`;
    const filePath = path.join(this.uploadsDir, fileName);

    // Save file
    fs.writeFileSync(filePath, file.buffer);

    // Delete old file if exists
    if (labOrder.receiptPath && fs.existsSync(labOrder.receiptPath)) {
      try {
        fs.unlinkSync(labOrder.receiptPath);
      } catch (error) {
        console.error('Error deleting old lab order:', error);
      }
    }

    // Update lab order record - change status to confirmed if it was pending
    const updateData: any = { receiptPath: filePath, receiptFileName: file.originalname };
    if (labOrder.status === 'pending') {
      updateData.status = 'confirmed';
    }

    const updatedOrder = await this.prisma.labOrder.update({
      where: { id: orderId },
      data: updateData,
    });

    // Send email to patient with attached lab order file whenever a file is uploaded
    if (labOrder.patient.primaryEmail) {
      try {
        const patientName = `${labOrder.patient.firstName} ${labOrder.patient.lastName}`;
        const testNames = labOrder.items.map(item => item.labTestType.name).join(', ');

        // Always attach the uploaded file
        await this.mailerService.sendLabOrderEmail(
          labOrder.patient.primaryEmail,
          patientName,
          testNames,
          filePath, // Pass file path for attachment
        );
      } catch (error) {
        console.error('Failed to send lab order email:', error);
        // Don't throw error - file upload succeeded
      }
    }

    return { filePath, fileName };
  }

  async uploadLabResults(orderId: string, file: any, notifyPatient: boolean = true): Promise<{ filePath: string; fileName: string; id: string }> {
    // Validate file
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    // Validate file type (images and PDFs)
    const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf'];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      throw new BadRequestException('Invalid file type. Please upload an image (JPEG, PNG, WebP) or PDF.');
    }

    // Validate file size (max 10MB)
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (file.size > maxSize) {
      throw new BadRequestException('File size exceeds 10MB limit.');
    }

    // Check if lab order exists with patient info
    const labOrder = await this.prisma.labOrder.findUnique({
      where: { id: orderId },
      include: {
        patient: true,
        items: {
          include: {
            labTestType: true,
          },
        },
      },
    });

    if (!labOrder) {
      throw new NotFoundException('Lab order not found');
    }

    // Generate unique filename
    const fileExtension = path.extname(file.originalname);
    const uniqueId = crypto.randomBytes(8).toString('hex');
    const fileName = `lab-results-${orderId}-${uniqueId}${fileExtension}`;
    const filePath = path.join(this.uploadsDir, fileName);

    // Save file
    fs.writeFileSync(filePath, file.buffer);

    // Create LabResultFile record
    const labResultFile = await this.prisma.labResultFile.create({
      data: {
        labOrderId: orderId,
        filePath: filePath,
        fileName: file.originalname,
        fileSize: file.size,
        mimeType: file.mimetype,
      },
    });

    // If this is the first result file, also update legacy resultsPath for backward compatibility
    const existingResultFiles = await this.prisma.labResultFile.count({
      where: { labOrderId: orderId },
    });

    if (existingResultFiles === 1 && !labOrder.resultsPath) {
      await this.prisma.labOrder.update({
        where: { id: orderId },
        data: { resultsPath: filePath },
      });
    }

    // Send email to patient with attached results file (only for first upload).
    // Skipped for patient self-uploads — the patient is uploading their OWN existing
    // results, so a "your results are ready" email would be wrong.
    if (notifyPatient && existingResultFiles === 1 && labOrder.patient.primaryEmail) {
      try {
        const patientName = `${labOrder.patient.firstName} ${labOrder.patient.lastName}`;
        const testNames = labOrder.items.map(item => item.labTestType.name).join(', ');

        // Attach the uploaded results file
        await this.mailerService.sendLabResultsEmail(
          labOrder.patient.primaryEmail,
          patientName,
          testNames,
          filePath, // Pass file path for attachment
        );
      } catch (error) {
        console.error('Failed to send lab results email:', error);
        // Don't throw error - file upload succeeded
      }
    }

    return { filePath, fileName: file.originalname, id: labResultFile.id };
  }

  async uploadPhoto(userId: string, file: any): Promise<{ filePath: string; fileName: string }> {
    // Validate file
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    // Validate file type (images only)
    const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      throw new BadRequestException('Invalid file type. Please upload an image (JPEG, PNG, WebP).');
    }

    // Validate file size (max 5MB)
    const maxSize = 5 * 1024 * 1024; // 5MB
    if (file.size > maxSize) {
      throw new BadRequestException('File size exceeds 5MB limit.');
    }

    // Check if user exists
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Generate unique filename
    const fileExtension = path.extname(file.originalname);
    const uniqueId = crypto.randomBytes(8).toString('hex');
    const fileName = `photo-${userId}-${uniqueId}${fileExtension}`;
    const filePath = path.join(this.uploadsDir, fileName);

    // Save file
    fs.writeFileSync(filePath, file.buffer);

    // Delete old file if exists
    if (user.photoPath && fs.existsSync(user.photoPath)) {
      try {
        fs.unlinkSync(user.photoPath);
      } catch (error) {
        console.error('Error deleting old photo:', error);
      }
    }

    // Update user record
    await this.prisma.user.update({
      where: { id: userId },
      data: { photoPath: filePath },
    });

    return { filePath, fileName };
  }

  async getUserUploadStatus(userId: string): Promise<{ hasDrivingLicense: boolean; hasPhoto: boolean }> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { drivingLicensePath: true, photoPath: true },
      });

      if (!user) {
        throw new NotFoundException('User not found');
      }

      // Check if files exist on filesystem
      const hasDrivingLicense = user.drivingLicensePath 
        ? fs.existsSync(user.drivingLicensePath) 
        : false;
      const hasPhoto = user.photoPath 
        ? fs.existsSync(user.photoPath) 
        : false;

      return {
        hasDrivingLicense,
        hasPhoto,
      };
    } catch (error) {
      console.error('Error getting upload status:', error);
      throw error;
    }
  }

  async removeDrivingLicense(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { drivingLicensePath: true },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Delete file if exists
    if (user.drivingLicensePath && fs.existsSync(user.drivingLicensePath)) {
      try {
        fs.unlinkSync(user.drivingLicensePath);
      } catch (error) {
        console.error('Error deleting driving license file:', error);
      }
    }

    // Update user record
    await this.prisma.user.update({
      where: { id: userId },
      data: { drivingLicensePath: null },
    });
  }

  async removePhoto(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { photoPath: true },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Delete file if exists
    if (user.photoPath && fs.existsSync(user.photoPath)) {
      try {
        fs.unlinkSync(user.photoPath);
      } catch (error) {
        console.error('Error deleting photo file:', error);
      }
    }

    // Update user record
    await this.prisma.user.update({
      where: { id: userId },
      data: { photoPath: null },
    });
  }

  /**
   * Resolve a stored file path to one that exists on the current server.
   * Files uploaded on one environment (e.g. Azure) have absolute paths that
   * won't exist locally.  We fall back to this.uploadsDir + basename so the
   * file is found regardless of where it was originally uploaded.
   */
  private resolveStoredPath(storedPath: string | null): string | null {
    if (!storedPath) return null;

    // Stored path exists as-is (normal case: same environment)
    if (fs.existsSync(storedPath)) return storedPath;

    // Fall back: resolve just the filename inside the current uploadsDir
    const fileName = path.basename(storedPath);
    if (fileName) {
      const localPath = path.join(this.uploadsDir, fileName);
      if (fs.existsSync(localPath)) return localPath;
    }

    return null;
  }

  async uploadPatientDocument(patientId: string, file: any, labOrderId?: string): Promise<{ id: string; filePath: string; fileName: string; originalName: string; createdAt: Date }> {
    if (!file) throw new BadRequestException('No file provided');

    const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf'];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      throw new BadRequestException('Invalid file type. Please upload an image (JPEG, PNG, WebP) or PDF.');
    }

    const maxSize = 10 * 1024 * 1024; // 10MB
    if (file.size > maxSize) throw new BadRequestException('File size exceeds 10MB limit.');

    const user = await this.prisma.user.findUnique({ where: { id: patientId } });
    if (!user) throw new NotFoundException('User not found');

    const fileExtension = path.extname(file.originalname);
    const uniqueId = crypto.randomBytes(8).toString('hex');
    const fileName = `document-${patientId}-${uniqueId}${fileExtension}`;
    const filePath = path.join(this.uploadsDir, fileName);

    fs.writeFileSync(filePath, file.buffer);

    const doc = await (this.prisma as any).patientDocument.create({
      data: {
        patientId,
        labOrderId: labOrderId || null,
        filePath,
        fileName,
        originalName: file.originalname,
      },
    });

    return doc;
  }

  // When labOrderId is provided, returns only that order's documents (per-row paperwork).
  // Otherwise returns the patient's general (non-order) documents.
  async getPatientDocuments(patientId: string, labOrderId?: string): Promise<any[]> {
    const user = await this.prisma.user.findUnique({ where: { id: patientId } });
    if (!user) throw new NotFoundException('User not found');

    return (this.prisma as any).patientDocument.findMany({
      where: labOrderId ? { patientId, labOrderId } : { patientId, labOrderId: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getPatientDocumentFilePath(documentId: string): Promise<string> {
    const doc = await (this.prisma as any).patientDocument.findUnique({ where: { id: documentId } });
    if (!doc) throw new NotFoundException('Document not found');

    const filePath = this.resolveStoredPath(doc.filePath);
    if (!filePath) throw new NotFoundException('Document file not found');
    return filePath;
  }

  async deletePatientDocument(documentId: string): Promise<void> {
    const doc = await (this.prisma as any).patientDocument.findUnique({ where: { id: documentId } });
    if (!doc) throw new NotFoundException('Document not found');

    if (doc.filePath && fs.existsSync(doc.filePath)) {
      try { fs.unlinkSync(doc.filePath); } catch {}
    }

    await (this.prisma as any).patientDocument.delete({ where: { id: documentId } });
  }

  async getFilePath(userId: string, type: 'drivingLicense' | 'photo'): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { drivingLicensePath: true, photoPath: true },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const storedPath = type === 'drivingLicense' ? user.drivingLicensePath : user.photoPath;
    const filePath = this.resolveStoredPath(storedPath);

    if (!filePath) {
      throw new NotFoundException(`${type} file not found`);
    }

    return filePath;
  }

  async getLabFilePath(orderId: string, type: 'receipt' | 'results'): Promise<string> {
    const info = await this.getLabFileInfo(orderId, type);
    return info.filePath;
  }

  async getLabFileInfo(orderId: string, type: 'receipt' | 'results'): Promise<{ filePath: string; originalName: string }> {
    const labOrder = await this.prisma.labOrder.findUnique({
      where: { id: orderId },
      select: { receiptPath: true, receiptFileName: true, resultsPath: true },
    });

    if (!labOrder) {
      throw new NotFoundException('Lab order not found');
    }

    const storedPath = type === 'receipt' ? labOrder.receiptPath : labOrder.resultsPath;
    const filePath = this.resolveStoredPath(storedPath);

    if (!filePath) {
      throw new NotFoundException(`Lab ${type} file not found`);
    }

    const originalName =
      type === 'receipt' && labOrder.receiptFileName
        ? labOrder.receiptFileName
        : path.basename(filePath);

    return { filePath, originalName };
  }

  async getLabResultFilePath(resultFileId: string): Promise<string> {
    const resultFile = await this.prisma.labResultFile.findUnique({
      where: { id: resultFileId },
    });

    if (!resultFile) {
      throw new NotFoundException('Lab result file not found');
    }

    const filePath = this.resolveStoredPath(resultFile.filePath);

    if (!filePath) {
      throw new NotFoundException('Lab result file not found on disk');
    }

    return filePath;
  }

  async getLabResultFileInfo(resultFileId: string): Promise<any> {
    const resultFile = await this.prisma.labResultFile.findUnique({
      where: { id: resultFileId },
    });

    if (!resultFile) {
      throw new NotFoundException('Lab result file not found');
    }

    return resultFile;
  }

  async getAllLabResultFiles(orderId: string): Promise<any[]> {
    const resultFiles = await this.prisma.labResultFile.findMany({
      where: { labOrderId: orderId },
      orderBy: { createdAt: 'desc' },
    });

    return resultFiles.map(file => ({
      id: file.id,
      fileName: file.fileName,
      fileSize: file.fileSize,
      mimeType: file.mimeType,
      createdAt: file.createdAt,
    }));
  }

  async removeLabOrder(orderId: string): Promise<void> {
    const labOrder = await this.prisma.labOrder.findUnique({
      where: { id: orderId },
    });

    if (!labOrder) {
      throw new NotFoundException('Lab order not found');
    }

    if (!labOrder.receiptPath) {
      throw new NotFoundException('Lab order file not found');
    }

    // Delete file from disk
    if (fs.existsSync(labOrder.receiptPath)) {
      try {
        fs.unlinkSync(labOrder.receiptPath);
      } catch (error) {
        console.error('Error deleting lab order file:', error);
      }
    }

    // Update lab order record
    await this.prisma.labOrder.update({
      where: { id: orderId },
      data: { receiptPath: null },
    });
  }

  async removeLabResults(orderId: string): Promise<void> {
    // Delete all result files for this order
    const resultFiles = await this.prisma.labResultFile.findMany({
      where: { labOrderId: orderId },
    });

    for (const resultFile of resultFiles) {
      if (fs.existsSync(resultFile.filePath)) {
        try {
          fs.unlinkSync(resultFile.filePath);
        } catch (error) {
          console.error('Error deleting lab results file:', error);
        }
      }
    }

    // Delete all result file records
    await this.prisma.labResultFile.deleteMany({
      where: { labOrderId: orderId },
    });

    // Update lab order record (legacy field)
    await this.prisma.labOrder.update({
      where: { id: orderId },
      data: { resultsPath: null },
    });
  }

  async removeLabResultFile(resultFileId: string): Promise<void> {
    const resultFile = await this.prisma.labResultFile.findUnique({
      where: { id: resultFileId },
      include: { labOrder: true },
    });

    if (!resultFile) {
      throw new NotFoundException('Lab result file not found');
    }

    // Delete file from disk
    if (fs.existsSync(resultFile.filePath)) {
      try {
        fs.unlinkSync(resultFile.filePath);
      } catch (error) {
        console.error('Error deleting lab result file:', error);
      }
    }

    // Delete result file record
    await this.prisma.labResultFile.delete({
      where: { id: resultFileId },
    });

    // If this was the last result file, update legacy resultsPath
    const remainingFiles = await this.prisma.labResultFile.count({
      where: { labOrderId: resultFile.labOrderId },
    });

    if (remainingFiles === 0) {
      await this.prisma.labOrder.update({
        where: { id: resultFile.labOrderId },
        data: { resultsPath: null },
      });
    } else if (resultFile.labOrder.resultsPath === resultFile.filePath) {
      // Update legacy resultsPath to point to the most recent file
      const mostRecentFile = await this.prisma.labResultFile.findFirst({
        where: { labOrderId: resultFile.labOrderId },
        orderBy: { createdAt: 'desc' },
      });

      if (mostRecentFile) {
        await this.prisma.labOrder.update({
          where: { id: resultFile.labOrderId },
          data: { resultsPath: mostRecentFile.filePath },
        });
      }
    }
  }
}

