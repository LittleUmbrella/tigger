/**
 * Shared utility for downloading images from Telegram messages
 */

import { TelegramClient, Api } from 'telegram';
import { logger } from './logger.js';
import fs from 'fs-extra';
import path from 'path';

export interface ImageDownloadOptions {
  channel: string;
  downloadImages: boolean;
}

/**
 * Downloads images from a Telegram message and stores them locally
 * @param options Configuration options
 * @param client Telegram client instance
 * @param msg Telegram message
 * @returns Array of relative file paths (relative to data directory)
 */
export async function downloadMessageImages(
  options: ImageDownloadOptions,
  client: TelegramClient,
  msg: Api.Message
): Promise<string[]> {
  if (!options.downloadImages) {
    return [];
  }

  const imagePaths: string[] = [];
  
  try {
    // Check if message has media (photos)
    if (!('media' in msg) || !msg.media) {
      return [];
    }

    // Handle photo media
    if (msg.media instanceof Api.MessageMediaPhoto) {
      const photo = msg.media.photo;
      if (!(photo instanceof Api.Photo)) {
        return [];
      }

      const msgId = Number(msg.id);
      const sanitizedChannel = options.channel.replace(/[^a-zA-Z0-9_-]/g, '_');
      const imageDir = path.join('data', 'images', sanitizedChannel, String(msgId));
      
      // Ensure directory exists
      await fs.ensureDir(imageDir);

      // Download the photo
      try {
        const buffer = await client.downloadMedia(msg, {});
        if (!buffer) {
          logger.warn('Failed to download image buffer', {
            channel: options.channel,
            messageId: msgId
          });
          return [];
        }

        // Determine file extension (default to jpg for photos)
        const fileExtension = 'jpg';
        const fileName = `image_${Date.now()}.${fileExtension}`;
        const filePath = path.join(imageDir, fileName);
        const relativePath = path.join('images', sanitizedChannel, String(msgId), fileName);

        await fs.writeFile(filePath, buffer);
        imagePaths.push(relativePath);

        logger.debug('Downloaded image from message', {
          channel: options.channel,
          messageId: msgId,
          path: relativePath
        });
      } catch (error) {
        logger.warn('Error downloading image', {
          channel: options.channel,
          messageId: msgId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    // Handle document media (could be images sent as documents)
    else if (msg.media instanceof Api.MessageMediaDocument) {
      const document = msg.media.document;
      if (!(document instanceof Api.Document)) {
        return [];
      }

      // Check if document is an image based on mime type
      const mimeType = document.mimeType || '';
      if (!mimeType.startsWith('image/')) {
        return [];
      }

      const msgId = Number(msg.id);
      const sanitizedChannel = options.channel.replace(/[^a-zA-Z0-9_-]/g, '_');
      const imageDir = path.join('data', 'images', sanitizedChannel, String(msgId));
      
      // Ensure directory exists
      await fs.ensureDir(imageDir);

      // Download the document
      try {
        const buffer = await client.downloadMedia(msg, {});
        if (!buffer) {
          logger.warn('Failed to download image document buffer', {
            channel: options.channel,
            messageId: msgId
          });
          return [];
        }

        // Determine file extension from mime type
        const mimeToExt: Record<string, string> = {
          'image/jpeg': 'jpg',
          'image/jpg': 'jpg',
          'image/png': 'png',
          'image/gif': 'gif',
          'image/webp': 'webp'
        };
        const fileExtension = mimeToExt[mimeType] || 'jpg';
        const fileName = `image_${Date.now()}.${fileExtension}`;
        const filePath = path.join(imageDir, fileName);
        const relativePath = path.join('images', sanitizedChannel, String(msgId), fileName);

        await fs.writeFile(filePath, buffer);
        imagePaths.push(relativePath);

        logger.debug('Downloaded image document from message', {
          channel: options.channel,
          messageId: msgId,
          path: relativePath
        });
      } catch (error) {
        logger.warn('Error downloading image document', {
          channel: options.channel,
          messageId: msgId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  } catch (error) {
    logger.warn('Error processing message media', {
      channel: options.channel,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  return imagePaths;
}

