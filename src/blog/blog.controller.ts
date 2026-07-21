import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { BlogService } from './blog.service';
import {
  CreateBlogCommentDto,
  CreateBlogPostDto,
  RecordBlogViewDto,
  SetBlogReactionDto,
  UpdateBlogCommentDto,
  UpdateBlogPostDto,
} from './dto/blog.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as fs from 'fs';
import * as path from 'path';
import { Request, Response } from 'express';

const BLOG_IMAGE_DIR = path.join(process.cwd(), 'uploads', 'blogs');

function ensureBlogImageDir() {
  if (!fs.existsSync(BLOG_IMAGE_DIR)) {
    fs.mkdirSync(BLOG_IMAGE_DIR, { recursive: true });
  }
}

@Controller('blogs')
export class BlogController {
  constructor(private readonly blogService: BlogService) {}

  private assertAdmin(req: any) {
    if (req.user?.userType !== 'admin') {
      throw new ForbiddenException('Admin access required');
    }
  }

  @Get()
  async listPublic(
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 9,
    @Query('tag') tag?: string,
    @Query('search') search?: string,
  ) {
    return this.blogService.listPublicPosts(page, limit, tag, search);
  }

  @Get(':slug')
  async getPublicPost(@Param('slug') slug: string, @Req() req: any) {
    const maybeUserId = req.user?.id;
    return this.blogService.getPublicPostBySlug(slug, maybeUserId);
  }

  @Get(':slug/comments')
  async getComments(@Param('slug') slug: string) {
    const post = await this.blogService.getPublicPostBySlug(slug);
    return this.blogService.getComments(post.id);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Post(':slug/comments')
  async createComment(
    @Param('slug') slug: string,
    @Body() dto: CreateBlogCommentDto,
    @Req() req: any,
  ) {
    const maybeUserId = req.user?.id;
    const post = await this.blogService.getPublicPostBySlug(slug, maybeUserId);
    return this.blogService.createComment(post.id, maybeUserId, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('comments/:commentId')
  async updateComment(
    @Param('commentId') commentId: string,
    @Body() dto: UpdateBlogCommentDto,
    @Req() req: any,
  ) {
    return this.blogService.updateComment(commentId, req.user.id, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('comments/:commentId')
  async deleteComment(@Param('commentId') commentId: string, @Req() req: any) {
    return this.blogService.deleteComment(commentId, req.user.id);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Post(':slug/reactions')
  async setReaction(
    @Param('slug') slug: string,
    @Body() dto: SetBlogReactionDto,
    @Req() req: any,
  ) {
    const maybeUserId = req.user?.id;
    const post = await this.blogService.getPublicPostBySlug(slug, maybeUserId);
    return this.blogService.setReaction(post.id, maybeUserId, dto);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Post(':slug/views')
  async recordView(
    @Param('slug') slug: string,
    @Body() dto: RecordBlogViewDto,
    @Req() req: any,
  ) {
    return this.blogService.recordPostView(slug, req.user?.id, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Get('admin/list')
  async listAdmin(
    @Req() req: any,
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 10,
    @Query('search') search?: string,
  ) {
    this.assertAdmin(req);
    return this.blogService.listAdminPosts(page, limit, undefined, search);
  }

  @UseGuards(JwtAuthGuard)
  @Get('admin/:postId/comments')
  async listAdminComments(@Req() req: any, @Param('postId') postId: string) {
    this.assertAdmin(req);
    return this.blogService.getComments(postId);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('admin/comments/:commentId')
  async deleteAdminComment(@Req() req: any, @Param('commentId') commentId: string) {
    this.assertAdmin(req);
    return this.blogService.deleteCommentAsAdmin(commentId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('admin')
  async createPost(@Req() req: any, @Body() dto: CreateBlogPostDto) {
    this.assertAdmin(req);
    return this.blogService.createPost(req.user.id, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Put('admin/:postId')
  async updatePost(
    @Req() req: any,
    @Param('postId') postId: string,
    @Body() dto: UpdateBlogPostDto,
  ) {
    this.assertAdmin(req);
    return this.blogService.updatePost(postId, req.user.id, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('admin/:postId')
  async deletePost(@Req() req: any, @Param('postId') postId: string) {
    this.assertAdmin(req);
    return this.blogService.deletePost(postId, req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('admin/upload-image')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          ensureBlogImageDir();
          cb(null, BLOG_IMAGE_DIR);
        },
        filename: (_req, file, cb) => {
          const ext = path.extname(file.originalname || '').toLowerCase();
          const safeExt = ext && ext.length <= 8 ? ext : '.jpg';
          cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${safeExt}`);
        },
      }),
      limits: { fileSize: 8 * 1024 * 1024 },
    }),
  )
  async uploadImage(@Req() req: any, @UploadedFile() file: Express.Multer.File) {
    this.assertAdmin(req);
    if (!file) {
      throw new BadRequestException('No image uploaded');
    }
    return {
      url: `/api/blogs/images/${file.filename}`,
      filename: file.filename,
    };
  }

  @Get('images/:filename')
  async getImage(@Param('filename') filename: string, @Req() req: Request, @Res() res: Response) {
    const safeName = path.basename(filename);
    const fullPath = path.join(BLOG_IMAGE_DIR, safeName);
    if (!fs.existsSync(fullPath)) {
      // 🔁 Legacy fallback — blog image uploaded on the old backend. Proxy it.
      const legacyOrigin = process.env.LEGACY_BACKEND_URL?.replace(/\/+$/, '');
      if (legacyOrigin) {
        try {
          const upstream = await fetch(`${legacyOrigin}${req.originalUrl}`);
          if (upstream.ok) {
            const contentType = upstream.headers.get('content-type');
            if (contentType) res.setHeader('Content-Type', contentType);
            return res.send(Buffer.from(await upstream.arrayBuffer()));
          }
        } catch (error) {
          console.error('Legacy blog image proxy failed:', error);
        }
      }
      throw new NotFoundException('Image not found');
    }
    return res.sendFile(fullPath);
  }
}
