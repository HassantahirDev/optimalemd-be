import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../mailer/mailer.service';
import { CreateContactDto, ContactResponseDto, UpdateContactStatusDto } from './dto/contact.dto';

@Injectable()
export class ContactService {
  constructor(
    private prisma: PrismaService,
    private mailerService: MailerService,
  ) {}

  async createContact(createContactDto: CreateContactDto): Promise<ContactResponseDto> {
    // Create contact in database
    const contact = await this.prisma.contact.create({
      data: createContactDto,
    });

    // Send email notification to hassantahir3556@gmail.com
    try {
      await this.sendContactNotificationEmail(contact);
    } catch (error) {
      console.error('Failed to send contact notification email:', error);
      // Don't fail the contact creation if email fails
    }

    return contact;
  }

  async getAllContacts(): Promise<ContactResponseDto[]> {
    return this.prisma.contact.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async getContactById(id: string): Promise<ContactResponseDto> {
    const contact = await this.prisma.contact.findUnique({
      where: { id },
    });

    if (!contact) {
      throw new NotFoundException('Contact not found');
    }

    return contact;
  }

  async updateContactStatus(id: string, updateStatusDto: UpdateContactStatusDto): Promise<ContactResponseDto> {
    const contact = await this.prisma.contact.update({
      where: { id },
      data: { status: updateStatusDto.status },
    });

    if (!contact) {
      throw new NotFoundException('Contact not found');
    }

    return contact;
  }

  async deleteContact(id: string): Promise<void> {
    const contact = await this.prisma.contact.delete({
      where: { id },
    });

    if (!contact) {
      throw new NotFoundException('Contact not found');
    }
  }

  private async sendContactNotificationEmail(contact: ContactResponseDto): Promise<void> {
    const subject = `New Contact Form Submission: ${contact.subject}`;
    const emailReceiver = 'drsam@optimalmd.health';
    
    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #e04845; border-bottom: 2px solid #e04845; padding-bottom: 10px;">
          New Contact Form Submission
        </h2>
        
        <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h3 style="color: #333; margin-top: 0;">Contact Details</h3>
          <p><strong>Name:</strong> ${contact.fullName}</p>
          <p><strong>Email:</strong> <a href="mailto:${contact.email}">${contact.email}</a></p>
          ${contact.phone ? `<p><strong>Phone:</strong> <a href="tel:${contact.phone}">${contact.phone}</a></p>` : ''}
          <p><strong>Subject:</strong> ${contact.subject}</p>
          <p><strong>Submitted:</strong> ${contact.createdAt.toLocaleString()}</p>
        </div>
        
        <div style="background-color: #fff; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
          <h3 style="color: #333; margin-top: 0;">Message</h3>
          <p style="white-space: pre-wrap; line-height: 1.6;">${contact.message}</p>
        </div>
        
        <div style="margin-top: 30px; padding: 15px; background-color: #e8f4f8; border-radius: 8px;">
          <p style="margin: 0; color: #666; font-size: 14px;">
            <strong>Next Steps:</strong> Please respond to this inquiry within 1-2 business days as promised on our website.
          </p>
        </div>
        
        <div style="margin-top: 20px; text-align: center; color: #666; font-size: 12px;">
          <p>This email was automatically generated from the FormaMD contact form.</p>
        </div>
      </div>
    `;

    const textContent = `
New Contact Form Submission

Contact Details:
- Name: ${contact.fullName}
- Email: ${contact.email}
${contact.phone ? `- Phone: ${contact.phone}` : ''}
- Subject: ${contact.subject}
- Submitted: ${contact.createdAt.toLocaleString()}

Message:
${contact.message}

Next Steps: Please respond to this inquiry within 1-2 business days as promised on our website.

This email was automatically generated from the FormaMD contact form.
    `;

    await this.mailerService.sendEmail(
      emailReceiver,
      subject,
      textContent,
      htmlContent
    );
  }
}
