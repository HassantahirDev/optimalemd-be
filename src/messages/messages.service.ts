import { Injectable, NotFoundException, BadRequestException, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMessageDto, MessageResponseDto, GetMessagesDto, MarkAsReadDto, GetConversationsDto } from './dto/message.dto';
import { MessagesGateway } from './messages.gateway';
import { MailerService } from '../mailer/mailer.service';

@Injectable()
export class MessagesService {
  constructor(
    private prisma: PrismaService,
    @Inject(forwardRef(() => MessagesGateway))
    private messagesGateway: MessagesGateway,
    private mailerService: MailerService
  ) {}

  /**
   * Create a new message
   */
  async createMessage(createMessageDto: CreateMessageDto, senderId: string): Promise<MessageResponseDto> {
    const { content, receiverId, senderType, receiverType } = createMessageDto;

    // Verify sender exists (check appropriate table based on senderType)
    let sender;
    if (senderType === 'doctor') {
      sender = await this.prisma.doctor.findUnique({
        where: { id: senderId }
      });
    } else {
      sender = await this.prisma.user.findUnique({
        where: { id: senderId }
      });
    }

    if (!sender) {
      throw new NotFoundException('Sender not found');
    }

    // Verify receiver exists (check appropriate table based on receiverType)
    let receiver;
    if (receiverType === 'doctor') {
      receiver = await this.prisma.doctor.findUnique({
        where: { id: receiverId }
      });
    } else {
      receiver = await this.prisma.user.findUnique({
        where: { id: receiverId }
      });
    }

    if (!receiver) {
      throw new NotFoundException('Receiver not found');
    }

    // Create the message
    const message = await this.prisma.message.create({
      data: {
        content,
        senderId,
        receiverId,
        senderType,
        receiverType,
        isRead: false
      }
    });

    // Get sender and receiver names separately since they might be in different tables
    let senderName, receiverName;

    if (senderType === 'doctor') {
      const doctorSender = await this.prisma.doctor.findUnique({
        where: { id: senderId },
        select: { firstName: true, lastName: true }
      });
      senderName = doctorSender ? `${doctorSender.firstName} ${doctorSender.lastName}` : 'Unknown Doctor';
    } else {
      const userSender = await this.prisma.user.findUnique({
        where: { id: senderId },
        select: { firstName: true, lastName: true }
      });
      senderName = userSender ? `${userSender.firstName} ${userSender.lastName}` : 'Unknown User';
    }

    if (receiverType === 'doctor') {
      const doctorReceiver = await this.prisma.doctor.findUnique({
        where: { id: receiverId },
        select: { firstName: true, lastName: true }
      });
      receiverName = doctorReceiver ? `${doctorReceiver.firstName} ${doctorReceiver.lastName}` : 'Unknown Doctor';
    } else {
      const userReceiver = await this.prisma.user.findUnique({
        where: { id: receiverId },
        select: { firstName: true, lastName: true }
      });
      receiverName = userReceiver ? `${userReceiver.firstName} ${userReceiver.lastName}` : 'Unknown User';
    }

    const messageResponse = {
      id: message.id,
      content: message.content,
      senderId: message.senderId,
      receiverId: message.receiverId,
      senderType: message.senderType,
      receiverType: message.receiverType,
      isRead: message.isRead,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      senderName,
      receiverName
    };

    // Emit message via WebSocket for real-time delivery
    try {
      this.messagesGateway.sendMessageToConversation(
        message.senderId, 
        message.receiverId, 
        'new_message', 
        messageResponse
      );
      console.log(`Message ${message.id} sent to conversation participants via WebSocket`);
    } catch (error) {
      console.error('Error sending message via WebSocket:', error);
      // Don't throw error here as message is already saved to database
    }

    // If a patient received this message, send an email reminder after 1 minute if still unread.
    if (receiverType === 'patient') {
      const normalizedSenderName = senderName.trim();
      const senderDisplayName =
        senderType === 'doctor'
          ? `Dr. ${normalizedSenderName.replace(/^dr\.?\s+/i, '')}`
          : normalizedSenderName;

      this.scheduleUnreadPatientMessageEmail(message.id, receiverId, senderDisplayName);
    }

    return messageResponse;
  }

  private scheduleUnreadPatientMessageEmail(messageId: string, receiverId: string, senderName: string): void {
    setTimeout(async () => {
      try {
        const message = await this.prisma.message.findUnique({
          where: { id: messageId },
          select: {
            id: true,
            isRead: true,
            receiverId: true,
            receiverType: true,
          },
        });

        // Only notify if this exact message is still unread by a patient receiver.
        if (!message || message.isRead || message.receiverType !== 'patient' || message.receiverId !== receiverId) {
          return;
        }

        const patient = await this.prisma.user.findUnique({
          where: { id: receiverId },
          select: {
            primaryEmail: true,
            firstName: true,
            lastName: true,
          },
        });

        if (!patient?.primaryEmail) {
          return;
        }

        const patientName = `${patient.firstName || ''} ${patient.lastName || ''}`.trim() || 'Patient';
        await this.mailerService.sendUnreadMessageReminderEmail(
          patient.primaryEmail,
          patientName,
          senderName,
        );
      } catch (error) {
        console.error(`Failed to send unread-message reminder for message ${messageId}:`, error);
      }
    }, 60_000);
  }

  /**
   * Get messages between two users
   */
  async getMessages(getMessagesDto: GetMessagesDto, userId: string): Promise<{
    messages: MessageResponseDto[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    const { otherParticipantId, page = 1, limit = 20 } = getMessagesDto;
    const skip = (page - 1) * limit;

    const messages = await this.prisma.message.findMany({
      where: {
        OR: [
          {
            senderId: userId,
            receiverId: otherParticipantId
          },
          {
            senderId: otherParticipantId,
            receiverId: userId
          }
        ]
      },
      orderBy: {
        createdAt: 'asc'
      },
      skip,
      take: limit
    });

    const total = await this.prisma.message.count({
      where: {
        OR: [
          {
            senderId: userId,
            receiverId: otherParticipantId
          },
          {
            senderId: otherParticipantId,
            receiverId: userId
          }
        ]
      }
    });

    // Get names for all messages
    const messageResponses: MessageResponseDto[] = await Promise.all(
      messages.map(async (message) => {
        let senderName, receiverName;

        // Get sender name
        if (message.senderType === 'doctor') {
          const doctorSender = await this.prisma.doctor.findUnique({
            where: { id: message.senderId },
            select: { firstName: true, lastName: true }
          });
          senderName = doctorSender ? `${doctorSender.firstName} ${doctorSender.lastName}` : 'Unknown Doctor';
        } else {
          const userSender = await this.prisma.user.findUnique({
            where: { id: message.senderId },
            select: { firstName: true, lastName: true }
          });
          senderName = userSender ? `${userSender.firstName} ${userSender.lastName}` : 'Unknown User';
        }

        // Get receiver name
        if (message.receiverType === 'doctor') {
          const doctorReceiver = await this.prisma.doctor.findUnique({
            where: { id: message.receiverId },
            select: { firstName: true, lastName: true }
          });
          receiverName = doctorReceiver ? `${doctorReceiver.firstName} ${doctorReceiver.lastName}` : 'Unknown Doctor';
        } else {
          const userReceiver = await this.prisma.user.findUnique({
            where: { id: message.receiverId },
            select: { firstName: true, lastName: true }
          });
          receiverName = userReceiver ? `${userReceiver.firstName} ${userReceiver.lastName}` : 'Unknown User';
        }

        return {
          id: message.id,
          content: message.content,
          senderId: message.senderId,
          receiverId: message.receiverId,
          senderType: message.senderType,
          receiverType: message.receiverType,
          isRead: message.isRead,
          createdAt: message.createdAt,
          updatedAt: message.updatedAt,
          senderName,
          receiverName
        };
      })
    );

    return {
      messages: messageResponses,
      total,
      page,
      totalPages: Math.ceil(total / limit)
    };
  }

  /**
   * Get all conversations for a user (temporarily shows all users)
   */
  async getConversations(getConversationsDto: GetConversationsDto): Promise<{
    conversations: Array<{
      participantId: string;
      participantName: string;
      participantType: string;
      lastMessage: MessageResponseDto | null;
      unreadCount: number;
    }>;
  }> {
    const { userId, userType } = getConversationsDto;

    // TEMPORARY: Get all users instead of just conversation participants
    let allUsers;
    if (userType === 'doctor') {
      // Get all patients for doctors
      allUsers = await this.prisma.user.findMany({
        select: {
          id: true,
          firstName: true,
          lastName: true,
          photoPath: true
        }
      });
    } else {
      // Get all doctors for patients
      allUsers = await this.prisma.doctor.findMany({
        select: {
          id: true,
          firstName: true,
          lastName: true
        }
      });
    }

    // Get last message and unread count for each user
    const conversations = await Promise.all(
      allUsers.map(async (user) => {
        const lastMessage = await this.prisma.message.findFirst({
          where: {
            OR: [
              {
                senderId: userId,
                receiverId: user.id
              },
              {
                senderId: user.id,
                receiverId: userId
              }
            ]
          },
          orderBy: {
            createdAt: 'desc'
          }
        });

        const unreadCount = await this.prisma.message.count({
          where: {
            senderId: user.id,
            receiverId: userId,
            isRead: false
          }
        });

        // Get names for last message if it exists
        let lastMessageResponse: MessageResponseDto | null = null;
        if (lastMessage) {
          let senderName, receiverName;

          // Get sender name
          if (lastMessage.senderType === 'doctor') {
            const doctorSender = await this.prisma.doctor.findUnique({
              where: { id: lastMessage.senderId },
              select: { firstName: true, lastName: true }
            });
            senderName = doctorSender ? `${doctorSender.firstName} ${doctorSender.lastName}` : 'Unknown Doctor';
          } else {
            const userSender = await this.prisma.user.findUnique({
              where: { id: lastMessage.senderId },
              select: { firstName: true, lastName: true }
            });
            senderName = userSender ? `${userSender.firstName} ${userSender.lastName}` : 'Unknown User';
          }

          // Get receiver name
          if (lastMessage.receiverType === 'doctor') {
            const doctorReceiver = await this.prisma.doctor.findUnique({
              where: { id: lastMessage.receiverId },
              select: { firstName: true, lastName: true }
            });
            receiverName = doctorReceiver ? `${doctorReceiver.firstName} ${doctorReceiver.lastName}` : 'Unknown Doctor';
          } else {
            const userReceiver = await this.prisma.user.findUnique({
              where: { id: lastMessage.receiverId },
              select: { firstName: true, lastName: true }
            });
            receiverName = userReceiver ? `${userReceiver.firstName} ${userReceiver.lastName}` : 'Unknown User';
          }

          lastMessageResponse = {
            id: lastMessage.id,
            content: lastMessage.content,
            senderId: lastMessage.senderId,
            receiverId: lastMessage.receiverId,
            senderType: lastMessage.senderType,
            receiverType: lastMessage.receiverType,
            isRead: lastMessage.isRead,
            createdAt: lastMessage.createdAt,
            updatedAt: lastMessage.updatedAt,
            senderName,
            receiverName
          };
        }

        return {
          participantId: user.id,
          participantName: `${user.firstName} ${user.lastName}`,
          participantType: userType === 'doctor' ? 'patient' : 'doctor',
          // Whether this participant has a profile photo (doctor→patient only).
          // The frontend loads it via /uploads/admin/photo/:id (proxy-backed, so it
          // resolves whether the image lives on the new OR old backend).
          participantHasPhoto: !!(user as any).photoPath,
          lastMessage: lastMessageResponse,
          unreadCount
        };
      })
    );

    // Sort by last message time (users with messages first, then alphabetically)
    conversations.sort((a, b) => {
      if (!a.lastMessage && !b.lastMessage) {
        return a.participantName.localeCompare(b.participantName);
      }
      if (!a.lastMessage) return 1;
      if (!b.lastMessage) return -1;
      return new Date(b.lastMessage.createdAt).getTime() - new Date(a.lastMessage.createdAt).getTime();
    });

    return { conversations };
  }

  /**
   * Mark a message as read
   */
  async markAsRead(markAsReadDto: MarkAsReadDto, userId: string): Promise<MessageResponseDto> {
    const { messageId } = markAsReadDto;

    const message = await this.prisma.message.findUnique({
      where: { id: messageId }
    });

    if (!message) {
      throw new NotFoundException('Message not found');
    }

    // Check if user is the receiver
    if (message.receiverId !== userId) {
      throw new BadRequestException('You can only mark your own received messages as read');
    }

    const updatedMessage = await this.prisma.message.update({
      where: { id: messageId },
      data: { isRead: true }
    });

    // Get sender and receiver names
    let senderName, receiverName;

    if (updatedMessage.senderType === 'doctor') {
      const doctorSender = await this.prisma.doctor.findUnique({
        where: { id: updatedMessage.senderId },
        select: { firstName: true, lastName: true }
      });
      senderName = doctorSender ? `${doctorSender.firstName} ${doctorSender.lastName}` : 'Unknown Doctor';
    } else {
      const userSender = await this.prisma.user.findUnique({
        where: { id: updatedMessage.senderId },
        select: { firstName: true, lastName: true }
      });
      senderName = userSender ? `${userSender.firstName} ${userSender.lastName}` : 'Unknown User';
    }

    if (updatedMessage.receiverType === 'doctor') {
      const doctorReceiver = await this.prisma.doctor.findUnique({
        where: { id: updatedMessage.receiverId },
        select: { firstName: true, lastName: true }
      });
      receiverName = doctorReceiver ? `${doctorReceiver.firstName} ${doctorReceiver.lastName}` : 'Unknown Doctor';
    } else {
      const userReceiver = await this.prisma.user.findUnique({
        where: { id: updatedMessage.receiverId },
        select: { firstName: true, lastName: true }
      });
      receiverName = userReceiver ? `${userReceiver.firstName} ${userReceiver.lastName}` : 'Unknown User';
    }

    return {
      id: updatedMessage.id,
      content: updatedMessage.content,
      senderId: updatedMessage.senderId,
      receiverId: updatedMessage.receiverId,
      senderType: updatedMessage.senderType,
      receiverType: updatedMessage.receiverType,
      isRead: updatedMessage.isRead,
      createdAt: updatedMessage.createdAt,
      updatedAt: updatedMessage.updatedAt,
      senderName,
      receiverName
    };
  }

  /**
   * Mark all messages from a specific sender as read
   */
  async markAllAsRead(senderId: string, receiverId: string): Promise<{ count: number }> {
    const result = await this.prisma.message.updateMany({
      where: {
        senderId,
        receiverId,
        isRead: false
      },
      data: {
        isRead: true
      }
    });

    return { count: result.count };
  }

  /**
   * Get unread message count for a user
   */
  async getUnreadCount(userId: string): Promise<{ count: number }> {
    const count = await this.prisma.message.count({
      where: {
        receiverId: userId,
        isRead: false
      }
    });

    return { count };
  }
}
