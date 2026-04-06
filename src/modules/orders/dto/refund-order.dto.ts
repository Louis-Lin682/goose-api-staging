import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export enum RefundRequestMode {
  FULL = 'FULL',
  PARTIAL = 'PARTIAL',
}

export class RefundOrderItemDto {
  @IsString()
  orderItemId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity!: number;
}

export class RefundOrderDto {
  @IsEnum(RefundRequestMode)
  mode!: RefundRequestMode;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;

  @ValidateIf((value: RefundOrderDto) => value.mode === RefundRequestMode.PARTIAL)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => RefundOrderItemDto)
  items?: RefundOrderItemDto[];
}
