import { Controller, Get, Post, Put, Delete, Body, Param, UseGuards } from '@nestjs/common';
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
