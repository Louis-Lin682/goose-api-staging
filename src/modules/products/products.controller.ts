import { Controller, Get } from '@nestjs/common';
import { ProductsService, type FeaturedProductsResponse, type ProductsResponse } from './products.service';

@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  getPublicProducts(): Promise<ProductsResponse> {
    return this.productsService.getPublicProducts();
  }

  @Get('featured')
  getFeaturedProducts(): Promise<FeaturedProductsResponse> {
    return this.productsService.getFeaturedProducts();
  }
}

