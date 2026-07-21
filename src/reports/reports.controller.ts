import { Controller, Post, Get, Param, HttpCode, HttpStatus, Req, Res } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { Request, Response } from 'express';
import * as fs from 'fs';

@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  /**
   * 🔁 Legacy file fallback — report PDFs generated on the OLD (optimalemd) backend
   * live on that server's disk and aren't present here after the move to formamd.
   * When a report isn't found locally, forward the SAME request to the old backend
   * (via LEGACY_BACKEND_URL, origin with no trailing /api) and stream it back.
   * Returns true if it served the file; false otherwise (caller then 404s).
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

  @Post('generate/:appointmentId')
  @HttpCode(HttpStatus.CREATED)
  async generate(@Param('appointmentId') appointmentId: string) {
    const result = await this.reportsService.generateReport(appointmentId);
    return {
      success: true,
      statusCode: HttpStatus.CREATED,
      message: 'Report generated successfully',
      data: result,
    };
  }

  @Get('download/:appointmentId')
  async download(
    @Param('appointmentId') appointmentId: string,
    @Req() req: Request,
    @Res() res: Response
  ) {
    try {
      console.log('Downloading report for appointment:', appointmentId);

      const fileInfo = await this.reportsService.getReportInfo(appointmentId);
      const filePath = await this.reportsService.getReportPath(appointmentId);

      console.log('Report file path:', filePath);

      // Check if file exists
      if (!fs.existsSync(filePath)) {
        console.error('Report file not found at path:', filePath);
        if (await this.proxyToLegacy(req, res)) return;
        return res.status(404).json({
          success: false,
          message: 'Report file not found',
        });
      }

      // Get file stats
      const stats = fs.statSync(filePath);
      console.log('File size:', stats.size, 'bytes');

      // Set headers and stream file
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${fileInfo.fileName}"`);
      res.setHeader('Content-Length', stats.size.toString());
      
      const fileStream = fs.createReadStream(filePath);
      
      fileStream.on('error', (error) => {
        console.error('Error reading file stream:', error);
        if (!res.headersSent) {
          res.status(500).json({
            success: false,
            message: 'Error streaming file',
          });
        }
      });
      
      fileStream.pipe(res);
    } catch (error) {
      console.error('Error downloading report:', error);
      if (!res.headersSent) {
        if (await this.proxyToLegacy(req, res)) return;
        res.status(500).json({
          success: false,
          message: 'Error downloading report',
          error: error.message,
        });
      }
    }
  }

  @Get('view/:appointmentId')
  async view(
    @Param('appointmentId') appointmentId: string,
    @Req() req: Request,
    @Res() res: Response
  ) {
    try {
      console.log('Viewing report for appointment:', appointmentId);

      const fileInfo = await this.reportsService.getReportInfo(appointmentId);
      const filePath = await this.reportsService.getReportPath(appointmentId);

      console.log('Report file path:', filePath);

      // Check if file exists
      if (!fs.existsSync(filePath)) {
        console.error('Report file not found at path:', filePath);
        if (await this.proxyToLegacy(req, res)) return;
        return res.status(404).json({
          success: false,
          message: 'Report file not found',
        });
      }

      // Get file stats to verify it's valid
      const stats = fs.statSync(filePath);
      console.log('File size:', stats.size, 'bytes');

      // Set headers and stream file
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${fileInfo.fileName}"`);
      res.setHeader('Content-Length', stats.size.toString());
      res.setHeader('Cache-Control', 'no-cache');
      
      const fileStream = fs.createReadStream(filePath);
      
      fileStream.on('error', (error) => {
        console.error('Error reading file stream:', error);
        if (!res.headersSent) {
          res.status(500).json({
            success: false,
            message: 'Error streaming file',
          });
        }
      });
      
      fileStream.pipe(res);
    } catch (error) {
      console.error('Error viewing report:', error);
      if (!res.headersSent) {
        if (await this.proxyToLegacy(req, res)) return;
        res.status(500).json({
          success: false,
          message: 'Error viewing report',
          error: error.message,
        });
      }
    }
  }
}


