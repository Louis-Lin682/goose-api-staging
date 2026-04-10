import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class FeaturedProductSlotDto {
  @Type(() => Number)
  @IsInt({ message: 'Slot must be an integer.' })
  @Min(1, { message: 'Slot must be between 1 and 3.' })
  @Max(3, { message: 'Slot must be between 1 and 3.' })
  slot!: number;

  @IsOptional()
  @IsString({ message: 'Product id must be a string.' })
  productId?: string | null;

  @IsOptional()
  @IsString({ message: 'Tag must be a string.' })
  tag?: string | null;

  @IsOptional()
  @IsString({ message: 'Description must be a string.' })
  description?: string | null;
}

export class UpdateFeaturedProductsDto {
  @IsArray({ message: 'Featured products must be an array.' })
  @ArrayMinSize(3, { message: 'Exactly 3 featured product slots are required.' })
  @ArrayMaxSize(3, { message: 'Exactly 3 featured product slots are required.' })
  @ValidateNested({ each: true })
  @Type(() => FeaturedProductSlotDto)
  featuredProducts!: FeaturedProductSlotDto[];
}
