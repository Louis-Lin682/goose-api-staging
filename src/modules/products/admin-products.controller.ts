import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../../common/guards/admin.guard';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateCategoryOrderDto } from './dto/update-category-order.dto';
import { UpdateFeaturedProductsDto } from './dto/update-featured-products.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import {
  type CreateProductResponse,
  type DeleteProductResponse,
  ProductsService,
  type ProductsResponse,
  type UpdateCategoryOrderResponse,
  type UpdateFeaturedProductsResponse,
  type FeaturedProductsResponse,
  type UpdateProductResponse,
} from './products.service';

@UseGuards(AdminGuard)
@Controller('admin/products')
export class AdminProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  getAdminProducts(): Promise<ProductsResponse> {
    return this.productsService.getAdminProducts();
  }

  @Get('featured')
  getAdminFeaturedProducts(): Promise<FeaturedProductsResponse> {
    return this.productsService.getAdminFeaturedProducts();
  }

  @Post()
  createProduct(
    @Body() createProductDto: CreateProductDto,
  ): Promise<CreateProductResponse> {
    return this.productsService.createProduct(createProductDto);
  }

  @Patch('featured')
  updateFeaturedProducts(
    @Body() updateFeaturedProductsDto: UpdateFeaturedProductsDto,
  ): Promise<UpdateFeaturedProductsResponse> {
    return this.productsService.updateFeaturedProducts(updateFeaturedProductsDto);
  }

  @Patch('category-order')
  updateCategoryOrder(
    @Body() updateCategoryOrderDto: UpdateCategoryOrderDto,
  ): Promise<UpdateCategoryOrderResponse> {
    return this.productsService.updateCategoryOrder(updateCategoryOrderDto);
  }

  @Patch(':productId')
  updateProduct(
    @Param('productId') productId: string,
    @Body() updateProductDto: UpdateProductDto,
  ): Promise<UpdateProductResponse> {
    return this.productsService.updateProduct(productId, updateProductDto);
  }

  @Delete('category/:category')
  deleteCategory(
    @Param('category') category: string,
  ): Promise<DeleteProductResponse> {
    return this.productsService.deleteCategory(category);
  }

  @Delete(':productId')
  deleteProduct(
    @Param('productId') productId: string,
  ): Promise<DeleteProductResponse> {
    return this.productsService.deleteProduct(productId);
  }
}

