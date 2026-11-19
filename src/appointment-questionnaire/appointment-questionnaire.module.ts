import { Module } from '@nestjs/common';
import { AppointmentQuestionnaireController } from './appointment-questionnaire.controller';
import { AppointmentQuestionnaireService } from './appointment-questionnaire.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [AppointmentQuestionnaireController],
  providers: [AppointmentQuestionnaireService],
  exports: [AppointmentQuestionnaireService],
})
export class AppointmentQuestionnaireModule {}
