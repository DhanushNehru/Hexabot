/*
 * Copyright © 2024 Hexastack. All rights reserved.
 *
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3) with the following additional terms:
 * 1. The name "Hexabot" is a trademark of Hexastack. You may not use this name in derivative works without express written permission.
 * 2. All derivative works must include clear attribution to the original creator and software, Hexastack and Hexabot, in a prominent location (e.g., in the software's "About" section, documentation, and README file).
 * 3. SaaS Restriction: This software, or any derivative of it, may not be used to offer a competing product or service (SaaS) without prior written consent from Hexastack. Offering the software as a service or using it in a commercial cloud environment without express permission is strictly prohibited.
 */

import fs from 'fs';
import { join } from 'path';
import { Readable } from 'stream';

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
  UseInterceptors,
} from '@nestjs/common';
import { CsrfCheck } from '@tekuconcept/nestjs-csrf';
import { Response } from 'express';
import { TFilterQuery } from 'mongoose';
import Papa from 'papaparse';

import { AttachmentService } from '@/attachment/services/attachment.service';
import { config } from '@/config';
import { CsrfInterceptor } from '@/interceptors/csrf.interceptor';
import { LoggerService } from '@/logger/logger.service';
import { BaseController } from '@/utils/generics/base-controller';
import { PageQueryDto } from '@/utils/pagination/pagination-query.dto';
import { PageQueryPipe } from '@/utils/pagination/pagination-query.pipe';
import { PopulatePipe } from '@/utils/pipes/populate.pipe';
import { SearchFilterPipe } from '@/utils/pipes/search-filter.pipe';

import { NlpSampleCreateDto, NlpSampleDto } from '../dto/nlp-sample.dto';
import {
  NlpSample,
  NlpSampleFull,
  NlpSamplePopulate,
  NlpSampleStub,
} from '../schemas/nlp-sample.schema';
import { NlpSampleEntityValue, NlpSampleState } from '../schemas/types';
import { NlpEntityService } from '../services/nlp-entity.service';
import { NlpSampleEntityService } from '../services/nlp-sample-entity.service';
import { NlpSampleService } from '../services/nlp-sample.service';
import { NlpService } from '../services/nlp.service';

@UseInterceptors(CsrfInterceptor)
@Controller('nlpsample')
export class NlpSampleController extends BaseController<
  NlpSample,
  NlpSampleStub,
  NlpSamplePopulate,
  NlpSampleFull
> {
  constructor(
    private readonly nlpSampleService: NlpSampleService,
    private readonly attachmentService: AttachmentService,
    private readonly nlpSampleEntityService: NlpSampleEntityService,
    private readonly nlpEntityService: NlpEntityService,
    private readonly logger: LoggerService,
    private readonly nlpService: NlpService,
  ) {
    super(nlpSampleService);
  }

  /**
   * Exports the NLP samples in a formatted JSON file, using the Rasa NLU format.
   *
   * @param response - Response object to handle file download.
   * @param type - Optional filter for NLP sample type.
   *
   * @returns A streamable JSON file containing the exported data.
   */
  @Get('export')
  async export(
    @Res({ passthrough: true }) response: Response,
    @Query('type') type?: NlpSampleState,
  ) {
    const samples = await this.nlpSampleService.findAndPopulate(
      type ? { type } : {},
    );
    const entities = await this.nlpEntityService.findAllAndPopulate();
    const result = this.nlpSampleService.formatRasaNlu(samples, entities);

    // Sending the JSON data as a file
    const buffer = Buffer.from(JSON.stringify(result));
    const readableInstance = new Readable({
      read() {
        this.push(buffer);
        this.push(null); // indicates the end of the stream
      },
    });

    return new StreamableFile(readableInstance, {
      type: 'application/json',
      disposition: `attachment; filename=nlp_export${
        type ? `_${type}` : ''
      }.json`,
    });
  }

  /**
   * Creates a new NLP sample with associated entities.
   *
   * @param createNlpSampleDto - The DTO containing the NLP sample and its entities.
   *
   * @returns The newly created NLP sample with its entities.
   */
  @CsrfCheck(true)
  @Post()
  async create(
    @Body() { entities: nlpEntities, ...createNlpSampleDto }: NlpSampleDto,
  ): Promise<NlpSampleFull> {
    const nlpSample = await this.nlpSampleService.create(
      createNlpSampleDto as NlpSampleCreateDto,
    );

    const entities = await this.nlpSampleEntityService.storeSampleEntities(
      nlpSample,
      nlpEntities,
    );

    return {
      ...nlpSample,
      entities,
    };
  }

  /**
   * Counts the filtered number of NLP samples.
   *
   * @param filters - The filters to apply when counting samples.
   *
   * @returns The count of samples that match the filters.
   */
  @Get('count')
  async filterCount(
    @Query(new SearchFilterPipe<NlpSample>({ allowedFields: ['text', 'type'] }))
    filters?: TFilterQuery<NlpSample>,
  ) {
    return await this.count(filters);
  }

  /**
   * Analyzes the input text using the NLP service and returns the parsed result.
   *
   * @param text - The input text to be analyzed.
   *
   * @returns The result of the NLP parsing process.
   */
  @Get('message')
  async message(@Query('text') text: string) {
    return this.nlpService.getNLP().parse(text);
  }

  /**
   * Fetches the samples and entities for a given sample type.
   *
   * @param type - The sample type (e.g., 'train', 'test').
   * @returns An object containing the samples and entities.
   * @private
   */
  private async getSamplesAndEntitiesByType(type: NlpSample['type']) {
    const samples = await this.nlpSampleService.findAndPopulate({
      type,
    });

    const entities = await this.nlpEntityService.findAllAndPopulate();

    return { samples, entities };
  }

  /**
   * Initiates the training process for the NLP service using the 'train' sample type.
   *
   * @returns The result of the training process.
   */
  @Get('train')
  async train() {
    const { samples, entities } =
      await this.getSamplesAndEntitiesByType('train');

    return await this.nlpService.getNLP().train(samples, entities);
  }

  /**
   * Evaluates the NLP service using the 'test' sample type.
   *
   * @returns The result of the evaluation process.
   */
  @Get('evaluate')
  async evaluate() {
    const { samples, entities } =
      await this.getSamplesAndEntitiesByType('test');

    return await this.nlpService.getNLP().evaluate(samples, entities);
  }

  /**
   * Finds a single NLP sample by its ID.
   *
   * @param id - The ID of the NLP sample to find.
   * @param populate - Fields to populate in the returned sample.
   *
   * @returns The requested NLP sample if found.
   */
  @Get(':id')
  async findOne(
    @Param('id') id: string,
    @Query(PopulatePipe) populate: string[],
  ) {
    const doc = this.canPopulate(populate)
      ? await this.nlpSampleService.findOneAndPopulate(id)
      : await this.nlpSampleService.findOne(id);
    if (!doc) {
      this.logger.warn(`Unable to find NLP Sample by id ${id}`);
      throw new NotFoundException(`NLP Sample with ID ${id} not found`);
    }
    return doc;
  }

  /**
   * Finds a paginated list of NLP samples.
   *
   * @param pageQuery - The query for pagination.
   * @param populate - Fields to populate in the returned samples.
   * @param filters - Filters to apply when fetching samples.
   *
   * @returns A paginated list of NLP samples.
   */
  @Get()
  async findPage(
    @Query(PageQueryPipe) pageQuery: PageQueryDto<NlpSample>,
    @Query(PopulatePipe) populate: string[],
    @Query(new SearchFilterPipe<NlpSample>({ allowedFields: ['text', 'type'] }))
    filters: TFilterQuery<NlpSample>,
  ) {
    return this.canPopulate(populate)
      ? await this.nlpSampleService.findPageAndPopulate(filters, pageQuery)
      : await this.nlpSampleService.findPage(filters, pageQuery);
  }

  /**
   * Updates an existing NLP sample by its ID.
   *
   * @param id - The ID of the NLP sample to update.
   * @param updateNlpSampleDto - The DTO containing the updated sample data.
   *
   * @returns The updated NLP sample with its entities.
   */
  @CsrfCheck(true)
  @Patch(':id')
  async updateOne(
    @Param('id') id: string,
    @Body() updateNlpSampleDto: NlpSampleDto,
  ): Promise<NlpSampleFull> {
    const { text, type, entities } = updateNlpSampleDto;
    const sample = await this.nlpSampleService.updateOne(id, {
      text,
      type,
      trained: false,
    });

    if (!sample) {
      this.logger.warn(`Unable to update NLP Sample by id ${id}`);
      throw new NotFoundException(`NLP Sample with ID ${id} not found`);
    }

    await this.nlpSampleEntityService.deleteMany({ sample: id });

    const updatedSampleEntities =
      await this.nlpSampleEntityService.storeSampleEntities(sample, entities);

    return {
      ...sample,
      entities: updatedSampleEntities,
    };
  }

  /**
   * Deletes an NLP sample by its ID.
   *
   * @param id - The ID of the NLP sample to delete.
   *
   * @returns The result of the deletion operation.
   */
  @CsrfCheck(true)
  @Delete(':id')
  @HttpCode(204)
  async deleteOne(@Param('id') id: string) {
    const result = await this.nlpSampleService.deleteCascadeOne(id);
    if (result.deletedCount === 0) {
      this.logger.warn(`Unable to delete NLP Sample by id ${id}`);
      throw new NotFoundException(`NLP Sample with ID ${id} not found`);
    }
    return result;
  }

  /**
   * Imports NLP samples from a CSV file.
   *
   * @param file - The file path or ID of the CSV file to import.
   *
   * @returns A success message after the import process is completed.
   */
  @CsrfCheck(true)
  @Post('import/:file')
  async import(
    @Param('file')
    file: string,
  ) {
    // Check if file is present
    const importedFile = await this.attachmentService.findOne(file);
    if (!importedFile) {
      throw new NotFoundException('Missing file!');
    }
    const filePath = importedFile
      ? join(config.parameters.uploadDir, importedFile.location)
      : undefined;

    // Check if file location is present
    if (!fs.existsSync(filePath)) {
      throw new NotFoundException('File does not exist');
    }

    const allEntities = await this.nlpEntityService.findAll();

    // Check if file location is present
    if (allEntities.length === 0) {
      throw new NotFoundException(
        'No entities found, please create them first.',
      );
    }

    // Read file content
    const data = fs.readFileSync(filePath, 'utf8');

    // Parse local CSV file
    const result: {
      errors: any[];
      data: Array<Record<string, string>>;
    } = Papa.parse(data, {
      header: true,
      skipEmptyLines: true,
    });

    if (result.errors && result.errors.length > 0) {
      this.logger.warn(
        `Errors parsing the file: ${JSON.stringify(result.errors)}`,
      );
      throw new BadRequestException(result.errors, {
        cause: result.errors,
        description: 'Error while parsing CSV',
      });
    }
    // Remove data with no intent
    const filteredData = result.data.filter((d) => d.intent !== 'none');
    // Reduce function to ensure executing promises one by one
    for (const d of filteredData) {
      try {
        // Check if a sample with the same text already exists
        const existingSamples = await this.nlpSampleService.find({
          text: d.text,
        });

        // Skip if sample already exists

        if (Array.isArray(existingSamples) && existingSamples.length > 0) {
          continue;
        }

        // Create a new sample dto
        const sample: NlpSampleCreateDto = {
          text: d.text,
          trained: false,
        };

        // Create a new sample entity dto
        const entities: NlpSampleEntityValue[] = allEntities
          .filter(({ name }) => name in d)
          .map(({ name }) => {
            return {
              entity: name,
              value: d[name],
            };
          });

        // Store any new entity/value
        const storedEntities = await this.nlpEntityService.storeNewEntities(
          sample.text,
          entities,
          ['trait'],
        );
        // Store sample
        const createdSample = await this.nlpSampleService.create(sample);
        // Map and assign the sample ID to each stored entity
        const sampleEntities = storedEntities.map((se) => ({
          ...se,
          sample: createdSample?.id,
        }));

        // Store sample entities
        await this.nlpSampleEntityService.createMany(sampleEntities);
      } catch (err) {
        this.logger.error('Error occurred when extracting data. ', err);
      }
    }

    this.logger.log('Import process completed successfully.');
    return { success: true };
  }
}
