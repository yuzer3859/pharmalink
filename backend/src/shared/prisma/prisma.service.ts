import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Single shared PrismaClient for the whole modular monolith. Every module's repositories
 * inject THIS service — never instantiate PrismaClient elsewhere (see ADR-001/002 and the
 * implementation roadmap §2). Connection is lazy on module init so unit tests that mock this
 * service never touch a database.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
