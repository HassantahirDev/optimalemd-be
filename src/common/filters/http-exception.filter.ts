import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ErrorApiResponse } from '../dto/api-response.dto';

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    
    const status = exception.getStatus();
    const exceptionResponse = exception.getResponse();
    
    // Generate request ID for tracking
    const requestId = this.generateRequestId();
    
    // Extract error details
    let message: string;
    let details: string[] | undefined;
    let error: string;
    // Any extra fields the thrower attached beyond the standard message/error/statusCode
    // (e.g. `throw new BadRequestException({ message, clashStartTime, clashEndTime })`) —
    // forwarded as-is so callers can use them instead of parsing the message string.
    let extraFields: Record<string, unknown> | undefined;

    if (typeof exceptionResponse === 'string') {
      message = exceptionResponse;
      error = this.getErrorType(status);
    } else if (typeof exceptionResponse === 'object') {
      const responseObj = exceptionResponse as any;
      message = responseObj.message || responseObj.error || 'An error occurred';

      // Handle validation errors
      if (Array.isArray(responseObj.message)) {
        details = responseObj.message;
        message = 'Validation failed';
      }

      error = responseObj.error || this.getErrorType(status);

      const { message: _m, error: _e, statusCode: _s, ...rest } = responseObj;
      if (Object.keys(rest).length > 0) {
        extraFields = rest;
      }
    } else {
      message = 'An error occurred';
      error = this.getErrorType(status);
    }

    // Format error response
    const errorResponse: ErrorApiResponse = {
      success: false,
      statusCode: status,
      message,
      error,
      details,
      timestamp: new Date().toISOString(),
      path: request.url,
      requestId,
      ...extraFields,
    };

    // Log error for debugging
    console.error(`[${requestId}] ${request.method} ${request.url} - ${status}: ${message}`, {
      requestId,
      method: request.method,
      url: request.url,
      status,
      message,
      error,
      details,
      userAgent: request.get('User-Agent'),
      ip: request.ip,
      timestamp: errorResponse.timestamp,
    });

    response.status(status).json(errorResponse);
  }

  private getErrorType(status: number): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return 'ValidationError';
      case HttpStatus.UNAUTHORIZED:
        return 'AuthenticationError';
      case HttpStatus.FORBIDDEN:
        return 'AuthorizationError';
      case HttpStatus.NOT_FOUND:
        return 'NotFoundError';
      case HttpStatus.CONFLICT:
        return 'ConflictError';
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return 'ValidationError';
      case HttpStatus.TOO_MANY_REQUESTS:
        return 'RateLimitError';
      case HttpStatus.INTERNAL_SERVER_ERROR:
        return 'InternalServerError';
      default:
        return 'HttpError';
    }
  }

  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}
