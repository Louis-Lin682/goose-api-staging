import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
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

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  refundShippingFee?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => RefundOrderItemDto)
  items?: RefundOrderItemDto[];
}
