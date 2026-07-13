import { NestFactory } from '@nestjs/core';
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  console.log('🚀 Starting OptimaleMD Backend...');
  console.log('NODE_ENV:', process.env.NODE_ENV);
  console.log('PORT:', process.env.PORT);
  
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug', 'verbose'],
    rawBody: true, // Enable raw body for webhook signature verification
  });
  
  // Global validation pipe
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }));
  
  // Global prefix - exclude health, homepage, and Stripe Terminal POS routes (same paths as standalone Express)
  app.setGlobalPrefix('api', {
    exclude: [
      '/health',
      '/',
      { path: 'robots933456.txt', method: RequestMethod.GET },
      { path: 'create-payment-intent', method: RequestMethod.POST },
      { path: 'process-payment', method: RequestMethod.POST },
      { path: 'cancel-payment', method: RequestMethod.POST },
      { path: 'create-customer', method: RequestMethod.POST },
      { path: 'save-card-on-reader', method: RequestMethod.POST },
      { path: 'create-membership-subscription', method: RequestMethod.POST },
      { path: 'catalog/one-time', method: RequestMethod.GET },
      { path: 'catalog/recurring', method: RequestMethod.GET },
      { path: 'setup-intent-status', method: RequestMethod.GET },
      { path: 'search-customers', method: RequestMethod.GET },
      { path: 'pos', method: RequestMethod.GET },
    ],
  });
  
  // CORS
  app.enableCors(
    {
      origin: [
        'https://optimalmd-mu.vercel.app',
        'http://localhost:3000',  
        'https://www.optimalemd.health', 
        'https://optimalemd.health',
        'http://localhost:5173',
        'http://localhost:5174',
        'http://localhost:8080'
      ],
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      credentials: true,
    },
  );
  
  // Swagger configuration
  const config = new DocumentBuilder()
    .setTitle('OptimaleMD API')
    .setDescription('The OptimaleMD Backend API for patient management and authentication')
    .setVersion('1.0')
    .addTag('auth', 'Authentication endpoints')
    .addTag('users', 'User management endpoints')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'JWT',
        description: 'Enter JWT token',
        in: 'header',
      },
      'JWT-auth', // This name here is important for references
    )
    .build();
  
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
    },
  });
  
  const port = process.env.PORT || 3000;
  await app.listen(port, '0.0.0.0');
  console.log(`✅ Application is running on: http://0.0.0.0:${port}`);
  console.log(`📚 Swagger documentation available at: http://0.0.0.0:${port}/api/docs`);
  console.log(`🏥 Health check available at: http://0.0.0.0:${port}/health`);
  console.log('🌐 CORS enabled for: ALL ORIGINS');
}

bootstrap().catch((error) => {
  console.error('❌ Failed to start application:', error);
  process.exit(1);
});
