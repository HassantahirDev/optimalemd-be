import {
  Controller,
  Post,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Get,
  Delete,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { UploadsService } from './uploads.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/user.decorator';
import * as path from 'path';
import * as fs from 'fs';

@ApiTags('Uploads')
@Controller('uploads')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  /**
   * 🔁 Legacy file fallback. Files uploaded on the OLD (optimalemd) backend live on
   * that server's disk, so they aren't present on this (formamd) server after the
   * move. When a file isn't found locally, forward the SAME request (path +
   * Authorization header) to the old backend and stream its response back. Both
   * backends share the same DB + JWT secret, so the caller's token authorizes the
   * exact same file there (patient sees own doc; admin sees any).
   * Configured via LEGACY_BACKEND_URL (origin only, no trailing /api).
   * Returns true if it served the file; false if it couldn't (caller then 404s).
   */
  private async proxyToLegacy(req: Request, res: Response): Promise<boolean> {
    const legacyOrigin = process.env.LEGACY_BACKEND_URL?.replace(/\/+$/, '');
    if (!legacyOrigin) {
      console.warn('[legacy-proxy] LEGACY_BACKEND_URL is NOT set — cannot proxy', req.originalUrl);
      return false;
    }
    const url = `${legacyOrigin}${req.originalUrl}`;
    try {
      const auth = (req.headers['authorization'] as string) || '';
      console.log(`[legacy-proxy] → ${url} (auth: ${auth ? 'present' : 'MISSING'})`);
      const upstream = await fetch(url, { headers: { Authorization: auth } });
      if (!upstream.ok) {
        console.warn(`[legacy-proxy] ✗ upstream ${upstream.status} ${upstream.statusText} for ${url}`);
        return false;
      }
      const contentType = upstream.headers.get('content-type');
      if (contentType) res.setHeader('Content-Type', contentType);
      const disposition = upstream.headers.get('content-disposition');
      if (disposition) res.setHeader('Content-Disposition', disposition);
      const buf = Buffer.from(await upstream.arrayBuffer());
      console.log(`[legacy-proxy] ✓ served ${buf.length} bytes from ${url}`);
      res.send(buf);
      return true;
    } catch (error) {
      console.error(`[legacy-proxy] ✗ error for ${url}:`, error?.message || error);
      return false;
    }
  }

  @Post('admin/migrate-legacy-files')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('superadmin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'One-time migration: copy all files from the legacy backend onto this server (superadmin only)' })
  async migrateLegacyFiles(@Req() req: Request) {
    const authHeader = (req.headers['authorization'] as string) || '';
    const result = await this.uploadsService.migrateLegacyFiles(authHeader);
    return { success: true, statusCode: HttpStatus.OK, message: 'Legacy file migration complete', data: result };
  }

  @Post('driving-license')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Upload driving license', description: 'Upload a driving license image or PDF for identity verification' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Driving license uploaded successfully' })
  @ApiResponse({ status: 400, description: 'Invalid file type or size' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async uploadDrivingLicense(
    @CurrentUser() user: any,
    @UploadedFile() file: any,
  ) {
    const result = await this.uploadsService.uploadDrivingLicense(user.id, file);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Driving license uploaded successfully',
      data: result,
    };
  }

  @Post('photo')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Upload photo', description: 'Upload a photo for identity verification' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Photo uploaded successfully' })
  @ApiResponse({ status: 400, description: 'Invalid file type or size' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async uploadPhoto(
    @CurrentUser() user: any,
    @UploadedFile() file: any,
  ) {
    const result = await this.uploadsService.uploadPhoto(user.id, file);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Photo uploaded successfully',
      data: result,
    };
  }

  @Get('status')
  @ApiOperation({ summary: 'Get upload status', description: 'Check if user has uploaded required documents' })
  @ApiResponse({ status: 200, description: 'Upload status retrieved successfully' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async getUploadStatus(@CurrentUser() user: any) {
    const status = await this.uploadsService.getUserUploadStatus(user.id);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Upload status retrieved successfully',
      data: status,
    };
  }

  @Delete('driving-license')
  @ApiOperation({ summary: 'Remove driving license', description: 'Remove the uploaded driving license' })
  @ApiResponse({ status: 200, description: 'Driving license removed successfully' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async removeDrivingLicense(@CurrentUser() user: any) {
    await this.uploadsService.removeDrivingLicense(user.id);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Driving license removed successfully',
    };
  }

  @Delete('photo')
  @ApiOperation({ summary: 'Remove photo', description: 'Remove the uploaded photo' })
  @ApiResponse({ status: 200, description: 'Photo removed successfully' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async removePhoto(@CurrentUser() user: any) {
    await this.uploadsService.removePhoto(user.id);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Photo removed successfully',
    };
  }

  @Get('drivingLicense/:userId')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get driving license file', description: 'Retrieve the driving license file for preview' })
  @ApiResponse({ status: 200, description: 'File retrieved successfully' })
  @ApiResponse({ status: 404, description: 'File not found' })
  async getDrivingLicense(
    @CurrentUser() user: any,
    @Param('userId') userId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    // Users can only view their own documents
    if (user.id !== userId) {
      return res.status(HttpStatus.FORBIDDEN).json({ message: 'Access denied' });
    }
    
    try {
      const filePath = await this.uploadsService.getFilePath(userId, 'drivingLicense');
      return res.sendFile(filePath);
    } catch (error) {
      if (await this.proxyToLegacy(req, res)) return;
      return res.status(HttpStatus.NOT_FOUND).json({ message: 'File not found' });
    }
  }

  @Get('photo/:userId')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get photo file', description: 'Retrieve the photo file for preview' })
  @ApiResponse({ status: 200, description: 'File retrieved successfully' })
  @ApiResponse({ status: 404, description: 'File not found' })
  async getPhoto(
    @CurrentUser() user: any,
    @Param('userId') userId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    // Users can only view their own documents
    if (user.id !== userId) {
      return res.status(HttpStatus.FORBIDDEN).json({ message: 'Access denied' });
    }
    
    try {
      const filePath = await this.uploadsService.getFilePath(userId, 'photo');
      return res.sendFile(filePath);
    } catch (error) {
      if (await this.proxyToLegacy(req, res)) return;
      return res.status(HttpStatus.NOT_FOUND).json({ message: 'File not found' });
    }
  }

  @Post('lab-order/:orderId')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Upload lab order (Admin)', description: 'Upload a lab order for a lab order' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Lab order uploaded successfully' })
  @ApiResponse({ status: 400, description: 'Invalid file type or size' })
  @ApiResponse({ status: 404, description: 'Lab order not found' })
  async uploadLabOrder(
    @Param('orderId') orderId: string,
    @UploadedFile() file: any,
  ) {
    const result = await this.uploadsService.uploadLabOrder(orderId, file);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Lab order uploaded successfully',
      data: result,
    };
  }

  @Post('lab-results/:orderId')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Upload lab results (Admin)', description: 'Upload lab results for a lab order. Can be called multiple times to upload multiple files.' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Lab results uploaded successfully' })
  @ApiResponse({ status: 400, description: 'Invalid file type or size' })
  @ApiResponse({ status: 404, description: 'Lab order not found' })
  async uploadLabResults(
    @Param('orderId') orderId: string,
    @UploadedFile() file: any,
  ) {
    const result = await this.uploadsService.uploadLabResults(orderId, file);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Lab results uploaded successfully',
      data: result,
    };
  }

  @Get('lab-order/:orderId')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get lab order file', description: 'Retrieve the lab order file for preview' })
  @ApiResponse({ status: 200, description: 'File retrieved successfully' })
  @ApiResponse({ status: 404, description: 'File not found' })
  async getLabOrder(
    @Param('orderId') orderId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const { filePath, originalName } = await this.uploadsService.getLabFileInfo(orderId, 'receipt');

      const ext = path.extname(filePath).toLowerCase();
      let contentType = 'application/octet-stream';
      if (ext === '.pdf') contentType = 'application/pdf';
      else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
      else if (ext === '.png') contentType = 'image/png';
      else if (ext === '.webp') contentType = 'image/webp';

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(originalName)}"`);

      return res.sendFile(filePath);
    } catch (error) {
      if (await this.proxyToLegacy(req, res)) return;
      return res.status(HttpStatus.NOT_FOUND).json({ message: 'File not found' });
    }
  }

  @Get('lab-results/:orderId')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get lab results file (legacy)', description: 'Retrieve the legacy lab results file for preview. Use /lab-results/:orderId/list for all files.' })
  @ApiResponse({ status: 200, description: 'File retrieved successfully' })
  @ApiResponse({ status: 404, description: 'File not found' })
  async getLabResults(
    @Param('orderId') orderId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const filePath = await this.uploadsService.getLabFilePath(orderId, 'results');
      
      // Determine content type from file extension
      const ext = path.extname(filePath).toLowerCase();
      let contentType = 'application/octet-stream';
      
      if (ext === '.pdf') {
        contentType = 'application/pdf';
      } else if (ext === '.jpg' || ext === '.jpeg') {
        contentType = 'image/jpeg';
      } else if (ext === '.png') {
        contentType = 'image/png';
      } else if (ext === '.webp') {
        contentType = 'image/webp';
      }
      
      // Set content type header
      res.setHeader('Content-Type', contentType);
      
      return res.sendFile(filePath);
    } catch (error) {
      if (await this.proxyToLegacy(req, res)) return;
      return res.status(HttpStatus.NOT_FOUND).json({ message: 'File not found' });
    }
  }

  @Get('lab-results/:orderId/list')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get all lab result files', description: 'Retrieve list of all lab result files for a lab order' })
  @ApiResponse({ status: 200, description: 'Files retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Lab order not found' })
  async getAllLabResultFiles(
    @Param('orderId') orderId: string,
  ) {
    const files = await this.uploadsService.getAllLabResultFiles(orderId);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      data: files,
    };
  }

  @Get('lab-result-file/:resultFileId')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get specific lab result file', description: 'Retrieve a specific lab result file by ID' })
  @ApiResponse({ status: 200, description: 'File retrieved successfully' })
  @ApiResponse({ status: 404, description: 'File not found' })
  async getLabResultFile(
    @Param('resultFileId') resultFileId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const filePath = await this.uploadsService.getLabResultFilePath(resultFileId);
      const resultFile = await this.uploadsService.getLabResultFileInfo(resultFileId);

      let contentType = resultFile?.mimeType || 'application/octet-stream';

      if (contentType === 'application/octet-stream') {
        const ext = path.extname(filePath).toLowerCase();
        if (ext === '.pdf') contentType = 'application/pdf';
        else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
        else if (ext === '.png') contentType = 'image/png';
        else if (ext === '.webp') contentType = 'image/webp';
      }

      res.setHeader('Content-Type', contentType);
      if (resultFile?.fileName) {
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(resultFile.fileName)}"`);
      }

      return res.sendFile(filePath);
    } catch (error) {
      if (await this.proxyToLegacy(req, res)) return;
      return res.status(HttpStatus.NOT_FOUND).json({ message: 'File not found' });
    }
  }

  @Get('admin/drivingLicense/:userId')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get driving license file (Admin)', description: 'Retrieve the driving license file for a patient (admin access)' })
  @ApiResponse({ status: 200, description: 'File retrieved successfully' })
  @ApiResponse({ status: 404, description: 'File not found' })
  async getDrivingLicenseAdmin(
    @Param('userId') userId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const filePath = await this.uploadsService.getFilePath(userId, 'drivingLicense');
      
      // Determine content type from file extension
      const ext = path.extname(filePath).toLowerCase();
      let contentType = 'application/octet-stream';
      
      if (ext === '.pdf') {
        contentType = 'application/pdf';
      } else if (ext === '.jpg' || ext === '.jpeg') {
        contentType = 'image/jpeg';
      } else if (ext === '.png') {
        contentType = 'image/png';
      } else if (ext === '.webp') {
        contentType = 'image/webp';
      }
      
      // Set content type header
      res.setHeader('Content-Type', contentType);
      
      return res.sendFile(filePath);
    } catch (error) {
      if (await this.proxyToLegacy(req, res)) return;
      return res.status(HttpStatus.NOT_FOUND).json({ message: 'File not found' });
    }
  }

  @Get('admin/photo/:userId')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get photo file (Admin)', description: 'Retrieve the photo file for a patient (admin access)' })
  @ApiResponse({ status: 200, description: 'File retrieved successfully' })
  @ApiResponse({ status: 404, description: 'File not found' })
  async getPhotoAdmin(
    @Param('userId') userId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const filePath = await this.uploadsService.getFilePath(userId, 'photo');
      
      // Determine content type from file extension
      const ext = path.extname(filePath).toLowerCase();
      let contentType = 'application/octet-stream';
      
      if (ext === '.pdf') {
        contentType = 'application/pdf';
      } else if (ext === '.jpg' || ext === '.jpeg') {
        contentType = 'image/jpeg';
      } else if (ext === '.png') {
        contentType = 'image/png';
      } else if (ext === '.webp') {
        contentType = 'image/webp';
      }
      
      // Set content type header
      res.setHeader('Content-Type', contentType);
      
      return res.sendFile(filePath);
    } catch (error) {
      if (await this.proxyToLegacy(req, res)) return;
      return res.status(HttpStatus.NOT_FOUND).json({ message: 'File not found' });
    }
  }

  @Post('admin/documents/:patientId')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Upload patient document (Admin)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  async uploadPatientDocumentAdmin(
    @Param('patientId') patientId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('labOrderId') labOrderId?: string,
  ) {
    const result = await this.uploadsService.uploadPatientDocument(patientId, file, labOrderId);
    return { success: true, statusCode: HttpStatus.OK, message: 'Document uploaded successfully', data: result };
  }

  @Get('admin/documents/:patientId')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'List patient documents (Admin). Pass ?labOrderId= to scope to one lab order.' })
  async getPatientDocumentsAdmin(
    @Param('patientId') patientId: string,
    @Query('labOrderId') labOrderId?: string,
  ) {
    const docs = await this.uploadsService.getPatientDocuments(patientId, labOrderId);
    return { success: true, statusCode: HttpStatus.OK, data: docs };
  }

  @Get('admin/documents/file/:documentId')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'View a patient document file (Admin)' })
  async viewPatientDocumentAdmin(
    @Param('documentId') documentId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const filePath = await this.uploadsService.getPatientDocumentFilePath(documentId);
      const ext = path.extname(filePath).toLowerCase();
      let contentType = 'application/octet-stream';
      if (ext === '.pdf') contentType = 'application/pdf';
      else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
      else if (ext === '.png') contentType = 'image/png';
      else if (ext === '.webp') contentType = 'image/webp';
      res.setHeader('Content-Type', contentType);
      return res.sendFile(filePath);
    } catch (error) {
      if (await this.proxyToLegacy(req, res)) return;
      return res.status(HttpStatus.NOT_FOUND).json({ message: 'File not found' });
    }
  }

  @Delete('admin/documents/:documentId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('superadmin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a patient document (Superadmin only)' })
  async deletePatientDocumentAdmin(@Param('documentId') documentId: string) {
    await this.uploadsService.deletePatientDocument(documentId);
    return { success: true, statusCode: HttpStatus.OK, message: 'Document deleted successfully' };
  }

  @Delete('lab-order/:orderId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('superadmin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove lab order (Superadmin only)', description: 'Remove a lab order — restricted to superadmin' })
  @ApiResponse({ status: 200, description: 'Lab order removed successfully' })
  @ApiResponse({ status: 404, description: 'Lab order not found' })
  async removeLabOrder(
    @Param('orderId') orderId: string,
  ) {
    await this.uploadsService.removeLabOrder(orderId);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Lab order removed successfully',
    };
  }

  @Delete('lab-results/:orderId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('superadmin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove all lab results (Superadmin only)', description: 'Remove all lab results for a lab order — restricted to superadmin' })
  @ApiResponse({ status: 200, description: 'Lab results removed successfully' })
  @ApiResponse({ status: 404, description: 'Lab order or results not found' })
  async removeLabResults(
    @Param('orderId') orderId: string,
  ) {
    await this.uploadsService.removeLabResults(orderId);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Lab results removed successfully',
    };
  }

  @Delete('lab-result-file/:resultFileId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('superadmin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove specific lab result file (Superadmin only)', description: 'Remove a specific lab result file by ID — restricted to superadmin' })
  @ApiResponse({ status: 200, description: 'Lab result file removed successfully' })
  @ApiResponse({ status: 404, description: 'Lab result file not found' })
  async removeLabResultFile(
    @Param('resultFileId') resultFileId: string,
  ) {
    await this.uploadsService.removeLabResultFile(resultFileId);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Lab result file removed successfully',
    };
  }
}

