import { Controller, Get, Post, Put, Delete, Body, Param, Req, UseGuards } from '@nestjs/common';
import { ContactService } from './contact.service';
import { CreateContactDto, ContactResponseDto, UpdateContactStatusDto } from './dto/contact.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('contact')
export class ContactController {
  constructor(private readonly contactService: ContactService) {}

  @Post()
  async createContact(@Body() createContactDto: CreateContactDto): Promise<ContactResponseDto> {
    return this.contactService.createContact(createContactDto);
  }

  // Help request from the patient portal's Lab Analysis screen. Signed-in only,
  // and the patient's name comes from their token rather than the request body,
  // so it can't be spoofed.
  @Post('lab-analysis-help')
  @UseGuards(JwtAuthGuard)
  async sendLabAnalysisHelp(
    @Body() body: { email: string; phone: string; message: string },
    @Req() req: any,
  ) {
    const user = req.user || {};
    const patientName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
    const data = await this.contactService.sendLabAnalysisHelpRequest({
      email: body.email,
      phone: body.phone,
      message: body.message,
      patientName,
    });
    return { success: true, data, message: 'Your message has been sent to our support team.' };
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  async getAllContacts(): Promise<ContactResponseDto[]> {
    return this.contactService.getAllContacts();
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  async getContactById(@Param('id') id: string): Promise<ContactResponseDto> {
    return this.contactService.getContactById(id);
  }

  @Put(':id/status')
  @UseGuards(JwtAuthGuard)
  async updateContactStatus(
    @Param('id') id: string,
    @Body() updateStatusDto: UpdateContactStatusDto,
  ): Promise<ContactResponseDto> {
    return this.contactService.updateContactStatus(id, updateStatusDto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  async deleteContact(@Param('id') id: string): Promise<{ message: string }> {
    await this.contactService.deleteContact(id);
    return { message: 'Contact deleted successfully' };
  }
}
