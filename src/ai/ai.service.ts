import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI } from '@google/genai';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PrismaService } from '../prisma/prisma.service';

type LabTrendSourceFile = {
  labOrderId: string;
  resultFileId: string | null;
  scheduledDate: Date;
  filePath: string;
  fileName: string;
  mimeType: string;
  fileSize: number | null;
  createdAt: Date;
  remotePath: string | null;
};

type LabTrendAnalysisResult = {
  title: string;
  generatedAt: string;
  overallImpression: string;
  categories: Array<{
    key: string;
    title: string;
    summary: string;
    points: Array<{
      date: string;
      testName: string;
      value: string;
      unit: string | null;
      flag: 'normal' | 'high' | 'low' | 'critical' | 'unknown';
      referenceRange: string | null;
      sourceFile: string | null;
    }>;
  }>;
  limitations: string[];
};

@Injectable()
export class AiService {
  private readonly defaultLocation = 'us-central1';
  private readonly defaultModel = 'gemini-2.5-pro';

  // When a lab file isn't on THIS server's disk, try fetching it from each of these
  // backends in order (a file may live on the new OR the old backend). These MUST be
  // real API origins (…azurewebsites.net/api), NOT the frontend domain (formamd.com
  // returns the SPA's HTML for /api/*, which would corrupt the analysis).
  // Overridable via LAB_FILE_REMOTE_BASE_URLS (comma-separated).
  private readonly remoteApiBaseUrls: string[] = (
    process.env.LAB_FILE_REMOTE_BASE_URLS ||
    [
      'https://formamd-production-cpbfg3cdewf9grat.canadacentral-01.azurewebsites.net/api',
      'https://optimaleproduction-ckfmbfgyccfjg3dc.canadacentral-01.azurewebsites.net/api',
    ].join(',')
  )
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  private readonly labTrendAnalysisVersion = 'lab-trends-v3-structured-json-ui';

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  getConfigStatus() {
    const project = this.configService.get<string>('GOOGLE_CLOUD_PROJECT');
    const location = this.getLocation();
    const model = this.getModel();
    const hasCredentialsPath = Boolean(
      this.configService.get<string>('GOOGLE_APPLICATION_CREDENTIALS') ||
        process.env.GOOGLE_APPLICATION_CREDENTIALS,
    );
    const hasCredentialsJson = Boolean(
      this.configService.get<string>('GOOGLE_APPLICATION_CREDENTIALS_JSON') ||
        this.configService.get<string>('GOOGLE_APPLICATION_CREDENTIALS_BASE64'),
    );

    return {
      configured: Boolean(project),
      project: project || null,
      location,
      model,
      authMode: hasCredentialsPath || hasCredentialsJson
        ? 'service-account'
        : 'application-default-credentials',
      missing: project ? [] : ['GOOGLE_CLOUD_PROJECT'],
    };
  }

  async generateSample(prompt: string) {
    if (!prompt?.trim()) {
      throw new BadRequestException('Prompt is required');
    }

    const project = this.configService.get<string>('GOOGLE_CLOUD_PROJECT');
    const location = this.getLocation();
    const model = this.getModel();

    if (!project) {
      throw new BadRequestException(
        'GOOGLE_CLOUD_PROJECT is not configured in the backend environment.',
      );
    }

    try {
      this.ensureVertexCredentials();

      const client = new GoogleGenAI({
        vertexai: true,
        project,
        location,
      });

      const response = await client.models.generateContent({
        model,
        contents: prompt.trim(),
      });

      return {
        model,
        text: response.text || '',
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown Gemini error';

      throw new InternalServerErrorException(
        `Gemini request failed. Check Vertex AI API, billing, IAM, and ADC login. ${message}`,
      );
    }
  }

  async analyzeLabTrendsForAppointment(
    patientId: string,
    appointmentId: string,
    authorization?: string,
    force = false,
  ) {
    if (!patientId || !appointmentId) {
      throw new BadRequestException('patientId and appointmentId are required');
    }

    const appointment = await this.prisma.appointment.findFirst({
      where: { id: appointmentId, patientId },
      select: {
        id: true,
        patientId: true,
        notesSignedAt: true,
        drAssessmentNotes: true,
        labTrendAnalysisHash: true,
        labTrendAnalysisNote: true,
        labTrendAnalysisAt: true,
        patient: {
          select: {
            firstName: true,
            lastName: true,
            dateOfBirth: true,
            gender: true,
          },
        },
      },
    });

    if (!appointment) {
      throw new BadRequestException('Appointment not found for this patient');
    }

    const labOrders = await this.prisma.labOrder.findMany({
      where: { patientId },
      include: {
        items: { include: { labTestType: true } },
        resultFiles: { orderBy: { createdAt: 'asc' } },
      },
      orderBy: { scheduledDate: 'asc' },
    });

    const files: LabTrendSourceFile[] = labOrders.flatMap<LabTrendSourceFile>((order) => {
      const resultFiles: LabTrendSourceFile[] = order.resultFiles.map((file) => ({
        labOrderId: order.id,
        resultFileId: file.id,
        scheduledDate: order.scheduledDate,
        filePath: file.filePath,
        fileName: file.fileName,
        mimeType: file.mimeType || this.getMimeType(file.filePath),
        fileSize: file.fileSize ?? null,
        createdAt: file.createdAt,
        remotePath: `/uploads/lab-result-file/${file.id}`,
      }));

      if (resultFiles.length > 0 || !order.resultsPath) {
        return resultFiles;
      }

      return [
        {
          labOrderId: order.id,
          resultFileId: null,
          scheduledDate: order.scheduledDate,
          filePath: order.resultsPath,
          fileName: `legacy-results-${order.id}`,
          mimeType: this.getMimeType(order.resultsPath),
          fileSize: null,
          createdAt: order.updatedAt,
          remotePath: `/uploads/lab-results/${order.id}`,
        },
      ];
    });

    if (files.length === 0) {
      return {
        status: 'no_lab_results',
        skipped: true,
        message: 'No uploaded lab result files were found for this patient.',
      };
    }

    console.log('[AI lab trends] Candidate lab result files:', files.map((file) => ({
      fileName: file.fileName,
      localPath: file.filePath,
      localExists: fs.existsSync(file.filePath),
      remotePath: file.remotePath,
      mimeType: file.mimeType,
      fileSize: file.fileSize,
    })));

    const sourceHash = this.createLabSourceHash(files);
    const cachedNote = appointment.labTrendAnalysisNote;
    const hasUnreadableCachedNote = this.isUnreadableLabTrendNote(cachedNote);
    const cachedTrendData = cachedNote
      ? this.tryParseLabTrendAnalysis(cachedNote)
      : null;
    const canonicalCachedTrendData = cachedTrendData
      ? this.canonicalizeLabTrendDates(cachedTrendData, files)
      : null;
    const existingPatientAnalyses = force
      ? []
      : await this.prisma.appointment.findMany({
          where: {
            patientId,
            labTrendAnalysisNote: { not: null },
          },
          select: {
            id: true,
            labTrendAnalysisHash: true,
            labTrendAnalysisNote: true,
            labTrendAnalysisAt: true,
          },
          orderBy: { labTrendAnalysisAt: 'desc' },
        });

    const reusablePatientAnalysis = existingPatientAnalyses
      .map((analysis) => ({
        ...analysis,
        trendData: analysis.labTrendAnalysisNote
          ? this.canonicalizeLabTrendDates(
              this.tryParseLabTrendAnalysis(analysis.labTrendAnalysisNote),
              files,
            )
          : null,
      }))
      .find((analysis) => {
        if (!analysis.trendData) return false;
        if (this.isUnreadableLabTrendNote(analysis.labTrendAnalysisNote)) return false;

        return analysis.labTrendAnalysisHash === sourceHash ||
          this.cachedTrendCoversFiles(analysis.trendData, files);
      });

    if (reusablePatientAnalysis?.trendData) {
      const analyzedAt = reusablePatientAnalysis.labTrendAnalysisAt || new Date();
      const trendData = {
        ...reusablePatientAnalysis.trendData,
        generatedAt: analyzedAt.toISOString(),
      };
      await this.prisma.appointment.updateMany({
        where: { patientId },
        data: {
          labTrendAnalysisHash: sourceHash,
          labTrendAnalysisNote: JSON.stringify(trendData),
          labTrendAnalysisAt: analyzedAt,
        },
      });

      return {
        status: 'cached',
        skipped: true,
        sourceHash,
        analyzedAt,
        trendData,
      };
    }

    if (!force && canonicalCachedTrendData && !hasUnreadableCachedNote) {
      const analyzedAt = appointment.labTrendAnalysisAt || new Date();
      const trendData = {
        ...canonicalCachedTrendData,
        generatedAt: analyzedAt.toISOString(),
      };
      await this.prisma.appointment.updateMany({
        where: { patientId },
        data: {
          labTrendAnalysisHash: sourceHash,
          labTrendAnalysisNote: JSON.stringify(trendData),
          labTrendAnalysisAt: analyzedAt,
        },
      });

      return {
        status: 'cached',
        skipped: true,
        sourceHash,
        analyzedAt,
        trendData,
      };
    }

    const rawFreshTrendData = await this.runGeminiLabTrendAnalysis({
      patient: appointment.patient,
      labOrders,
      files,
      authorization,
    });
    const freshTrendData =
      this.canonicalizeLabTrendDates(rawFreshTrendData, files) || rawFreshTrendData;
    const mergedTrendData = !force && canonicalCachedTrendData
      ? this.mergeLabTrendAnalysis(canonicalCachedTrendData, freshTrendData)
      : freshTrendData;

    const analyzedAt = new Date();
    const trendData = {
      ...mergedTrendData,
      generatedAt: analyzedAt.toISOString(),
    };
    await this.prisma.appointment.updateMany({
      where: { patientId },
      data: {
        labTrendAnalysisHash: sourceHash,
        labTrendAnalysisNote: JSON.stringify(trendData),
        labTrendAnalysisAt: analyzedAt,
      },
    });

    return {
      status: force ? 'reanalyzed' : 'analyzed',
      skipped: false,
      sourceHash,
      analyzedAt,
      trendData,
      insertedIntoNote: false,
    };
  }

  private getLocation(): string {
    return (
      this.configService.get<string>('GOOGLE_CLOUD_LOCATION') ||
      this.defaultLocation
    );
  }

  private getModel(): string {
    return this.configService.get<string>('GEMINI_MODEL') || this.defaultModel;
  }

  private ensureVertexCredentials() {
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      return;
    }

    const credentialsPath = this.configService.get<string>('GOOGLE_APPLICATION_CREDENTIALS');
    if (credentialsPath) {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
      return;
    }

    const credentialsJson = this.configService.get<string>('GOOGLE_APPLICATION_CREDENTIALS_JSON');
    const credentialsBase64 = this.configService.get<string>('GOOGLE_APPLICATION_CREDENTIALS_BASE64');

    if (!credentialsJson && !credentialsBase64) {
      return;
    }

    const rawCredentials = credentialsJson ||
      Buffer.from(credentialsBase64 as string, 'base64').toString('utf8');

    try {
      JSON.parse(rawCredentials);
    } catch {
      throw new BadRequestException(
        'Google service account credentials are not valid JSON. Check GOOGLE_APPLICATION_CREDENTIALS_JSON or GOOGLE_APPLICATION_CREDENTIALS_BASE64.',
      );
    }

    const tempCredentialsPath = path.join(
      os.tmpdir(),
      'optimalemd-vertex-service-account.json',
    );

    fs.writeFileSync(tempCredentialsPath, rawCredentials, { mode: 0o600 });
    process.env.GOOGLE_APPLICATION_CREDENTIALS = tempCredentialsPath;
  }

  private async runGeminiLabTrendAnalysis({
    patient,
    labOrders,
    files,
    authorization,
  }: {
    patient: {
      firstName: string | null;
      lastName: string | null;
      dateOfBirth: Date | null;
      gender: string | null;
    };
    labOrders: Array<any>;
    files: LabTrendSourceFile[];
    authorization?: string;
  }): Promise<LabTrendAnalysisResult> {
    const project = this.configService.get<string>('GOOGLE_CLOUD_PROJECT');
    if (!project) {
      throw new BadRequestException(
        'GOOGLE_CLOUD_PROJECT is not configured in the backend environment.',
      );
    }

    this.ensureVertexCredentials();

    const client = new GoogleGenAI({
      vertexai: true,
      project,
      location: this.getLocation(),
    });

    const labTimeline = labOrders.map((order) => ({
      labOrderId: order.id,
      scheduledDate: order.scheduledDate,
      status: order.status,
      orderedTests: order.items.map((item) => item.labTestType.name),
      resultFiles: files
        .filter((file) => file.labOrderId === order.id)
        .map((file) => file.fileName),
    }));

    const prompt = `
You are extracting structured lab trends from uploaded lab result files for a clinician-facing UI.

Patient:
- Name: ${patient.firstName || ''} ${patient.lastName || ''}
- DOB: ${patient.dateOfBirth ? patient.dateOfBirth.toISOString().split('T')[0] : 'unknown'}
- Gender: ${patient.gender || 'unknown'}

Historical lab order timeline:
${JSON.stringify(labTimeline, null, 2)}

Task:
1. Read all attached lab result files, including scanned/visual PDF pages and table images.
2. Pull historical values and dates for these groups only:
   - Testosterone
   - Estradiol
   - Lipids
   - A1c
   - Thyroid labs
   - CBC
   - CMP
3. Display trends chronologically.
4. Include exact values and units when visible.
5. If a value is not present, omit that item.
6. Do not invent values.
7. Important: Quest PDFs often show result tables across multiple pages. Inspect every page. If one page is a requisition/order page, continue to later pages for actual result tables.
8. Treat rows like "CHOLESTEROL, TOTAL 215 H <200 mg/dL", "GLUCOSE 90 65-99 mg/dL", and "TESTOSTERONE, TOTAL 716 250-827 ng/dL" as readable lab result data.
9. Return ONLY valid JSON. No markdown, no code fences, no comments.
10. Every category must have a stable key from this set only:
    testosterone, estradiol, lipids, a1c, thyroid, cbc, cmp
11. For flags use only: normal, high, low, critical, unknown.
12. If there are no visible values for a category, omit that category entirely.
13. Extract every visible matching result, not just one representative value.
14. For repeated tests across multiple files or dates, include one point per test/date/source file. For example, Total Testosterone and Free Testosterone are separate tests and both must be included for every date where visible.
15. Use the lab result collection/specimen/result date shown in the file when visible. If only the lab order scheduled date is known, use that scheduled date.

Required JSON shape:
{
  "title": "AI Lab Trend Summary",
  "generatedAt": "ISO-8601 timestamp",
  "overallImpression": "brief clinician-facing trend impression",
  "categories": [
    {
      "key": "lipids",
      "title": "Lipids",
      "summary": "brief category summary",
      "points": [
        {
          "date": "2026-02-12",
          "testName": "Total cholesterol",
          "value": "215",
          "unit": "mg/dL",
          "flag": "high",
          "referenceRange": "<200 mg/dL",
          "sourceFile": "Lab Results 5.5:26.pdf"
        }
      ]
    }
  ],
  "limitations": []
}
`.trim();

    const fileParts = await Promise.all(
      files.map(async (file) => {
        const data = await this.readLabFileAsBase64(file, authorization);

        return {
          inlineData: {
            mimeType: file.mimeType,
            data,
          },
        };
      }),
    );

    try {
      const response = await client.models.generateContent({
        model: this.getModel(),
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }, ...fileParts],
          },
        ] as any,
        config: {
          responseMimeType: 'application/json',
          temperature: 0,
          topP: 0.1,
        },
      });

      const rawText = (response.text || '').trim();
      if (!rawText) {
        throw new Error('Gemini returned an empty lab trend analysis.');
      }

      return this.parseLabTrendAnalysis(rawText);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown Gemini error';
      throw new InternalServerErrorException(
        `Lab trend analysis failed. ${message}`,
      );
    }
  }

  private createLabSourceHash(files: LabTrendSourceFile[]) {
    const fileSignatures = files.map((file) => {
      const stat = fs.existsSync(file.filePath) ? fs.statSync(file.filePath) : null;
      return {
        labOrderId: file.labOrderId,
        resultFileId: file.resultFileId,
        scheduledDate: file.scheduledDate.toISOString(),
        fileName: file.fileName,
        mimeType: file.mimeType,
        size: stat?.size ?? file.fileSize,
        createdAt: file.createdAt.toISOString(),
      };
    }).sort((a, b) =>
      [
        a.labOrderId,
        a.resultFileId || '',
        a.fileName,
        a.createdAt,
      ].join('|').localeCompare([
        b.labOrderId,
        b.resultFileId || '',
        b.fileName,
        b.createdAt,
      ].join('|')),
    );

    return createHash('sha256')
      .update(JSON.stringify({
        analysisVersion: this.labTrendAnalysisVersion,
        fileSignatures,
      }))
      .digest('hex');
  }

  private tryParseLabTrendAnalysis(rawText: string): LabTrendAnalysisResult | null {
    try {
      return this.parseLabTrendAnalysis(rawText);
    } catch {
      return null;
    }
  }

  private parseLabTrendAnalysis(rawText: string): LabTrendAnalysisResult {
    const cleaned = this.extractJsonObject(rawText
      .trim()
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/i, '')
      .trim());

    let parsed: LabTrendAnalysisResult;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      console.error('[AI lab trends] Gemini returned invalid JSON preview:', {
        preview: rawText.slice(0, 1200),
      });
      throw new Error('Gemini returned invalid JSON for lab trend analysis.');
    }

    return this.normalizeLabTrendAnalysis(parsed);
  }

  private isUnreadableLabTrendNote(note?: string | null) {
    return Boolean(
      note?.toLowerCase().includes('do not contain readable lab result data') ||
        note?.toLowerCase().includes('unable to generate lab trend summary'),
    );
  }

  private extractJsonObject(value: string) {
    const firstBrace = value.indexOf('{');
    const lastBrace = value.lastIndexOf('}');

    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      return value;
    }

    return value.slice(firstBrace, lastBrace + 1);
  }

  private canonicalizeLabTrendDates(
    trendData: LabTrendAnalysisResult | null,
    files: LabTrendSourceFile[],
  ): LabTrendAnalysisResult | null {
    if (!trendData) return null;

    const fileDates = files.map((file) => ({
      fileName: file.fileName.trim().toLowerCase(),
      date: file.scheduledDate.toISOString().split('T')[0],
    }));

    return this.normalizeLabTrendAnalysis({
      ...trendData,
      categories: trendData.categories.map((category) => ({
        ...category,
        points: category.points.map((point) => ({
          ...point,
          date: this.getCanonicalLabDate(point.sourceFile, fileDates) || point.date,
        })),
      })),
    });
  }

  private getCanonicalLabDate(
    sourceFile: string | null,
    fileDates: Array<{ fileName: string; date: string }>,
  ) {
    if (!sourceFile) return null;

    const normalizedSource = sourceFile.trim().toLowerCase();
    const match = fileDates.find(({ fileName }) =>
      normalizedSource === fileName ||
        normalizedSource.includes(fileName) ||
        fileName.includes(normalizedSource),
    );

    return match?.date || null;
  }

  private cachedTrendCoversFiles(
    trendData: LabTrendAnalysisResult,
    files: LabTrendSourceFile[],
  ) {
    const sourceFiles = new Set(
      trendData.categories
        .flatMap((category) => category.points)
        .map((point) => point.sourceFile)
        .filter(Boolean)
        .map((sourceFile) => String(sourceFile).trim().toLowerCase()),
    );

    if (sourceFiles.size === 0) {
      return false;
    }

    return files.every((file) => {
      const fileName = file.fileName.trim().toLowerCase();
      return Array.from(sourceFiles).some(
        (sourceFile) => sourceFile === fileName ||
          sourceFile.includes(fileName) ||
          fileName.includes(sourceFile),
      );
    });
  }

  private mergeLabTrendAnalysis(
    cached: LabTrendAnalysisResult,
    fresh: LabTrendAnalysisResult,
  ): LabTrendAnalysisResult {
    const categoriesByKey = new Map<string, LabTrendAnalysisResult['categories'][number]>();

    [...cached.categories, ...fresh.categories].forEach((category) => {
      const existing = categoriesByKey.get(category.key);
      if (!existing) {
        categoriesByKey.set(category.key, {
          ...category,
          points: [...category.points],
        });
        return;
      }

      existing.summary = category.summary || existing.summary;
      existing.points.push(...category.points);
    });

    return this.normalizeLabTrendAnalysis({
      title: fresh.title || cached.title,
      generatedAt: fresh.generatedAt || cached.generatedAt,
      overallImpression: fresh.overallImpression || cached.overallImpression,
      categories: Array.from(categoriesByKey.values()),
      limitations: Array.from(new Set([
        ...cached.limitations,
        ...fresh.limitations,
      ])),
    });
  }

  private normalizeLabTrendAnalysis(
    input: Partial<LabTrendAnalysisResult>,
  ): LabTrendAnalysisResult {
    const allowedKeys = new Set([
      'testosterone',
      'estradiol',
      'lipids',
      'a1c',
      'thyroid',
      'cbc',
      'cmp',
    ]);
    const allowedFlags = new Set(['normal', 'high', 'low', 'critical', 'unknown']);

    return {
      title: input.title || 'AI Lab Trend Summary',
      generatedAt: new Date().toISOString(),
      overallImpression: input.overallImpression || 'No trend impression provided.',
      categories: Array.isArray(input.categories)
        ? input.categories
            .filter((category) => allowedKeys.has(category?.key))
            .map((category) => ({
              key: category.key,
              title: category.title || this.toTitleCase(category.key),
              summary: category.summary || '',
              points: Array.isArray(category.points)
                ? Array.from(
                    new Map(category.points.map((point) => {
                      const normalizedPoint = {
                        date: point.date || 'Unknown date',
                        testName: point.testName || 'Unknown test',
                        value: String(point.value ?? ''),
                        unit: point.unit ?? null,
                        flag: allowedFlags.has(point.flag) ? point.flag : 'unknown',
                        referenceRange: point.referenceRange ?? null,
                        sourceFile: point.sourceFile ?? null,
                      };
                      const pointKey = [
                        normalizedPoint.date,
                        normalizedPoint.testName.toLowerCase(),
                        normalizedPoint.sourceFile || '',
                      ].join('|');

                      return [pointKey, normalizedPoint];
                    })).values(),
                  ).sort((a, b) =>
                    `${a.date}|${a.testName}`.localeCompare(`${b.date}|${b.testName}`),
                  )
                : [],
            }))
            .filter((category) => category.points.length > 0)
        : [],
      limitations: Array.isArray(input.limitations) ? input.limitations : [],
    };
  }

  private toTitleCase(value: string) {
    return value
      .split(/[-_\s]+/)
      .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
      .join(' ');
  }

  private getMimeType(filePath: string) {
    const lower = filePath.toLowerCase();
    if (lower.endsWith('.pdf')) return 'application/pdf';
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    return 'application/octet-stream';
  }

  private async readLabFileAsBase64(
    file: LabTrendSourceFile,
    authorization?: string,
  ) {
    if (fs.existsSync(file.filePath)) {
      const buffer = fs.readFileSync(file.filePath);
      console.log('[AI lab trends] Reading local lab file:', {
        fileName: file.fileName,
        localPath: file.filePath,
        mimeType: file.mimeType,
        bytes: buffer.length,
      });
      return buffer.toString('base64');
    }

    if (!file.remotePath || this.remoteApiBaseUrls.length === 0) {
      throw new Error(`Lab result file is missing locally: ${file.fileName}`);
    }

    // The file may live on either backend (new or old). Try each in order and
    // accept the first that returns a real file (a valid status AND not the SPA's
    // HTML page — formamd.com/api/* returns text/html which must be rejected).
    const failures: string[] = [];
    for (const baseUrl of this.remoteApiBaseUrls) {
      const remoteUrl = `${baseUrl}${file.remotePath}`;
      try {
        console.log('[AI lab trends] Fetching remote lab file:', {
          fileName: file.fileName,
          remoteUrl,
          localPath: file.filePath,
          hasAuthorizationHeader: Boolean(authorization),
        });

        const response = await fetch(remoteUrl, {
          headers: authorization ? { Authorization: authorization } : undefined,
        });

        const contentType = response.headers.get('content-type');
        console.log('[AI lab trends] Remote lab file response:', {
          fileName: file.fileName,
          remoteUrl,
          status: response.status,
          contentType,
          contentLength: response.headers.get('content-length'),
        });

        if (!response.ok) {
          failures.push(`${remoteUrl} -> ${response.status}`);
          continue;
        }
        // Reject HTML (e.g. a frontend SPA responding 200 with its index page).
        if (contentType && contentType.includes('text/html')) {
          failures.push(`${remoteUrl} -> got HTML, not a file`);
          continue;
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length === 0) {
          failures.push(`${remoteUrl} -> empty`);
          continue;
        }
        if (contentType && contentType !== 'application/octet-stream') {
          file.mimeType = contentType.split(';')[0];
        }
        console.log('[AI lab trends] Remote lab file fetched:', {
          fileName: file.fileName,
          remoteUrl,
          mimeType: file.mimeType,
          bytes: buffer.length,
        });
        return buffer.toString('base64');
      } catch (e: any) {
        failures.push(`${remoteUrl} -> ${e?.message || e}`);
      }
    }

    throw new Error(
      `Unable to fetch lab result file "${file.fileName}" from any backend. Tried: ${failures.join('; ')}`,
    );
  }
}
