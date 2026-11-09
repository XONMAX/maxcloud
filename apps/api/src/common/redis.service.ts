import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { config } from '../config';

@Injectable()
export class RedisService extends Redis implements OnModuleDestroy {
  constructor() {
    super(config().REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
  }
  async onModuleDestroy() {
    this.disconnect();
  }
}
