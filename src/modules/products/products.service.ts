import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { INITIAL_PRODUCT_CATALOG } from './product-catalog';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { UpdateFeaturedProductsDto } from './dto/update-featured-products.dto';

export type ProductEntry = {
  id: string;
  category: string;
  categoryOrder: number;
  subCategory: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  price: number | null;
  priceSmall: number | null;
  priceLarge: number | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ProductsResponse = {
  products: ProductEntry[];
};

export type CreateProductResponse = {
  message: string;
  product: ProductEntry;
};

export type UpdateProductResponse = {
  message: string;
  product: ProductEntry;
};

export type DeleteProductResponse = {
  message: string;
};

export type UpdateCategoryOrderPayload = {
  category: string;
  categoryOrder: number;
};

export type UpdateCategoryOrderResponse = {
  message: string;
};

export type FeaturedProductEntry = {
  slot: number;
  productId: string | null;
  tag: string | null;
  description: string | null;
  product: ProductEntry | null;
};

export type FeaturedProductsResponse = {
  featuredProducts: FeaturedProductEntry[];
};

export type UpdateFeaturedProductsResponse = {
  message: string;
  featuredProducts: FeaturedProductEntry[];
};

@Injectable()
export class ProductsService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.syncInitialCatalog();
    await this.syncInitialCategoryOrder();
    await this.normalizeCategoryOrders();
    await this.ensureFeaturedProductSlots();
  }

  async syncInitialCatalog(): Promise<void> {
    const existingCount = await this.prisma.product.count();

    if (existingCount > 0) {
      return;
    }

    for (const item of INITIAL_PRODUCT_CATALOG) {
      await this.prisma.product.create({
        data: {
          id: item.id,
          category: item.category,
          categoryOrder: item.categoryOrder,
          subCategory: item.subCategory,
          name: item.name,
          description: item.description ?? null,
          imageUrl: item.imageUrl ?? null,
          price: item.price ?? null,
          priceSmall: item.priceSmall ?? null,
          priceLarge: item.priceLarge ?? null,
          isActive: item.isActive ?? true,
          sortOrder: item.sortOrder,
        },
      });
    }
  }

  async syncInitialCategoryOrder(): Promise<void> {
    const categoryOrderMap = new Map<string, number>();

    for (const item of INITIAL_PRODUCT_CATALOG) {
      if (!categoryOrderMap.has(item.category)) {
        categoryOrderMap.set(item.category, item.categoryOrder);
      }
    }

    for (const [category, categoryOrder] of categoryOrderMap.entries()) {
      await this.prisma.product.updateMany({
        where: {
          category,
          categoryOrder: 0,
        },
        data: {
          categoryOrder,
        },
      });
    }
  }

  async getPublicProducts(): Promise<ProductsResponse> {
    const products = await this.prisma.product.findMany({
      where: { isActive: true },
      orderBy: [
        { categoryOrder: 'asc' },
        { category: 'asc' },
        { sortOrder: 'asc' },
        { createdAt: 'asc' },
      ],
    });

    return { products };
  }

  async getAdminProducts(): Promise<ProductsResponse> {
    const products = await this.prisma.product.findMany({
      orderBy: [
        { categoryOrder: 'asc' },
        { category: 'asc' },
        { sortOrder: 'asc' },
        { createdAt: 'asc' },
      ],
    });

    return { products };
  }

  async getFeaturedProducts(): Promise<FeaturedProductsResponse> {
    return {
      featuredProducts: await this.getFeaturedProductEntries(),
    };
  }

  async getAdminFeaturedProducts(): Promise<FeaturedProductsResponse> {
    return {
      featuredProducts: await this.getFeaturedProductEntries(),
    };
  }

  async updateFeaturedProducts(
    updateFeaturedProductsDto: UpdateFeaturedProductsDto,
  ): Promise<UpdateFeaturedProductsResponse> {
    const uniqueSlots = new Set(updateFeaturedProductsDto.featuredProducts.map((item) => item.slot));

    if (uniqueSlots.size !== 3) {
      throw new BadRequestException('Featured product slots must include 1, 2, and 3 exactly once.');
    }

    const productIds = updateFeaturedProductsDto.featuredProducts
      .map((item) => item.productId?.trim())
      .filter((value): value is string => Boolean(value));

    if (productIds.length > 0) {
      const existingProducts = await this.prisma.product.findMany({
        where: {
          id: {
            in: productIds,
          },
        },
        select: {
          id: true,
        },
      });

      if (existingProducts.length !== new Set(productIds).size) {
        throw new NotFoundException('One or more selected featured products could not be found.');
      }
    }

    await this.prisma.$transaction(
      updateFeaturedProductsDto.featuredProducts.map((item) =>
        this.prisma.featuredProductSetting.upsert({
          where: { slot: item.slot },
          update: {
            productId: this.toNullableTrimmed(item.productId),
            tag: this.toNullableTrimmed(item.tag),
            description: this.toNullableTrimmed(item.description),
          },
          create: {
            slot: item.slot,
            productId: this.toNullableTrimmed(item.productId),
            tag: this.toNullableTrimmed(item.tag),
            description: this.toNullableTrimmed(item.description),
          },
        }),
      ),
    );

    return {
      message: '推薦產品已更新。',
      featuredProducts: await this.getFeaturedProductEntries(),
    };
  }


  async createProduct(
    createProductDto: CreateProductDto,
  ): Promise<CreateProductResponse> {
    const category = createProductDto.category.trim();
    const sortOrder = createProductDto.sortOrder ?? 0;
    const priceFields = this.normalizePricePayload(createProductDto);
    const existingCategory = await this.prisma.product.findFirst({
      where: { category },
      select: { categoryOrder: true },
    });

    await this.ensureUniqueSortOrder(category, sortOrder);

    const product = await this.prisma.$transaction(async (tx) => {
      if (existingCategory) {
        return tx.product.create({
          data: {
            id: this.createProductId(),
            category,
            categoryOrder: existingCategory.categoryOrder,
            subCategory: createProductDto.subCategory.trim(),
            name: createProductDto.name.trim(),
            description: createProductDto.description?.trim() || null,
            imageUrl: createProductDto.imageUrl?.trim() || null,
            price: priceFields.price ?? null,
            priceSmall: priceFields.priceSmall ?? null,
            priceLarge: priceFields.priceLarge ?? null,
            isActive: true,
            sortOrder,
          },
        });
      }

      const nextCategoryOrder = await this.getNextCategoryOrder(tx);
      const requestedOrder =
        createProductDto.categoryOrder ?? nextCategoryOrder;
      const categoryOrder = Math.min(
        Math.max(requestedOrder, 1),
        nextCategoryOrder,
      );

      await tx.product.updateMany({
        where: {
          categoryOrder: {
            gte: categoryOrder,
          },
        },
        data: {
          categoryOrder: {
            increment: 1,
          },
        },
      });

      return tx.product.create({
        data: {
          id: this.createProductId(),
          category,
          categoryOrder,
          subCategory: createProductDto.subCategory.trim(),
          name: createProductDto.name.trim(),
          description: createProductDto.description?.trim() || null,
          imageUrl: createProductDto.imageUrl?.trim() || null,
          price: priceFields.price ?? null,
          priceSmall: priceFields.priceSmall ?? null,
          priceLarge: priceFields.priceLarge ?? null,
          isActive: true,
          sortOrder,
        },
      });
    });

    await this.normalizeCategoryOrders();
    await this.ensureFeaturedProductSlots();

    return {
      message: '商品新增成功。',
      product,
    };
  }

  async updateProduct(
    productId: string,
    updateProductDto: UpdateProductDto,
  ): Promise<UpdateProductResponse> {
    const existingProduct = await this.prisma.product.findUnique({
      where: { id: productId },
    });

    if (!existingProduct) {
      throw new NotFoundException('Product not found.');
    }

    const nextCategory =
      updateProductDto.category?.trim() ?? existingProduct.category;
    const nextSortOrder =
      updateProductDto.sortOrder ?? existingProduct.sortOrder;
    const priceFields = this.normalizePricePayload({
      price:
        updateProductDto.price === undefined
          ? existingProduct.price
          : updateProductDto.price,
      priceSmall:
        updateProductDto.priceSmall === undefined
          ? existingProduct.priceSmall
          : updateProductDto.priceSmall,
      priceLarge:
        updateProductDto.priceLarge === undefined
          ? existingProduct.priceLarge
          : updateProductDto.priceLarge,
    });
    const isSameCategory = nextCategory === existingProduct.category;

    if (!isSameCategory) {
      await this.ensureUniqueSortOrder(nextCategory, nextSortOrder, productId);
    }

    const product = await this.prisma.$transaction(async (tx) => {
      const duplicatedProduct =
        isSameCategory && nextSortOrder !== existingProduct.sortOrder
          ? await tx.product.findFirst({
              where: {
                category: nextCategory,
                sortOrder: nextSortOrder,
                id: {
                  not: productId,
                },
              },
              select: {
                id: true,
              },
            })
          : null;

      if (duplicatedProduct) {
        await tx.product.update({
          where: { id: duplicatedProduct.id },
          data: {
            sortOrder: existingProduct.sortOrder,
          },
        });
      }

      const existingTargetCategory =
        nextCategory !== existingProduct.category
          ? await tx.product.findFirst({
              where: { category: nextCategory },
              select: { categoryOrder: true },
            })
          : null;

      return tx.product.update({
        where: { id: productId },
        data: {
          category: updateProductDto.category?.trim(),
          categoryOrder:
            updateProductDto.category?.trim() && existingTargetCategory
              ? existingTargetCategory.categoryOrder
              : updateProductDto.categoryOrder,
          subCategory: updateProductDto.subCategory?.trim(),
          name: updateProductDto.name?.trim(),
          description:
            updateProductDto.description === undefined
              ? undefined
              : updateProductDto.description?.trim() || null,
          imageUrl:
            updateProductDto.imageUrl === undefined
              ? undefined
              : updateProductDto.imageUrl?.trim() || null,
          price: priceFields.price,
          priceSmall: priceFields.priceSmall,
          priceLarge: priceFields.priceLarge,
          sortOrder: updateProductDto.sortOrder,
        },
      });
    });

    return {
      message: '商品更新成功。',
      product,
    };
  }

  async updateCategoryOrder(
    payload: UpdateCategoryOrderPayload,
  ): Promise<UpdateCategoryOrderResponse> {
    const category = payload.category.trim();
    const targetOrder = payload.categoryOrder;

    const currentCategory = await this.prisma.product.findFirst({
      where: { category },
      select: { categoryOrder: true },
    });

    if (!currentCategory) {
      throw new NotFoundException('Category not found.');
    }

    if (currentCategory.categoryOrder === targetOrder) {
      return {
        message: '分類排序未變更。',
      };
    }

    await this.prisma.$transaction(async (tx) => {
      const temporaryOrder = -999999;
      const categoryToSwap = await tx.product.findFirst({
        where: {
          categoryOrder: targetOrder,
          category: {
            not: category,
          },
        },
        select: {
          category: true,
        },
      });

      await tx.product.updateMany({
        where: {
          category,
        },
        data: {
          categoryOrder: temporaryOrder,
        },
      });

      if (categoryToSwap) {
        await tx.product.updateMany({
          where: {
            category: categoryToSwap.category,
          },
          data: {
            categoryOrder: currentCategory.categoryOrder,
          },
        });
      }

      await tx.product.updateMany({
        where: {
          category,
        },
        data: {
          categoryOrder: targetOrder,
        },
      });
    });

    return {
      message: '分類排序更新成功。',
    };
  }

  async deleteProduct(productId: string): Promise<DeleteProductResponse> {
    const existingProduct = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true },
    });

    if (!existingProduct) {
      throw new NotFoundException('Product not found.');
    }

    await this.prisma.$transaction([
      this.prisma.featuredProductSetting.updateMany({
        where: { productId },
        data: { productId: null },
      }),
      this.prisma.product.delete({
        where: { id: productId },
      }),
    ]);

    return {
      message: '商品刪除成功。',
    };
  }

  async deleteCategory(categoryName: string): Promise<DeleteProductResponse> {
    const category = decodeURIComponent(categoryName).trim();

    const existingCategory = await this.prisma.product.findFirst({
      where: { category },
      select: { id: true, categoryOrder: true },
    });

    if (!existingCategory) {
      throw new NotFoundException('分類不存在。');
    }

    const productIds = await this.prisma.product.findMany({
      where: { category },
      select: { id: true },
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.featuredProductSetting.updateMany({
        where: {
          productId: {
            in: productIds.map((item) => item.id),
          },
        },
        data: {
          productId: null,
        },
      });

      await tx.product.deleteMany({
        where: { category },
      });

      await tx.product.updateMany({
        where: {
          categoryOrder: {
            gt: existingCategory.categoryOrder,
          },
        },
        data: {
          categoryOrder: {
            decrement: 1,
          },
        },
      });
    });

    return {
      message: '分類刪除成功。',
    };
  }

    private async ensureFeaturedProductSlots(): Promise<void> {
    for (const slot of [1, 2, 3]) {
      await this.prisma.featuredProductSetting.upsert({
        where: { slot },
        update: {},
        create: { slot },
      });
    }
  }

  private async getFeaturedProductEntries(): Promise<FeaturedProductEntry[]> {
    await this.ensureFeaturedProductSlots();

    const settings = await this.prisma.featuredProductSetting.findMany({
      orderBy: { slot: 'asc' },
    });

    const productIds = settings
      .map((item) => item.productId)
      .filter((value): value is string => Boolean(value));

    const products = productIds.length
      ? await this.prisma.product.findMany({
          where: {
            id: {
              in: productIds,
            },
          },
        })
      : [];

    const productMap = new Map(products.map((product) => [product.id, product]));

    return [1, 2, 3].map((slot) => {
      const setting = settings.find((item) => item.slot === slot);
      const product = setting?.productId ? productMap.get(setting.productId) ?? null : null;

      return {
        slot,
        productId: setting?.productId ?? null,
        tag: setting?.tag ?? null,
        description: setting?.description ?? null,
        product,
      };
    });
  }

  private toNullableTrimmed(value?: string | null): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  }

  private normalizePricePayload(pricePayload: {
    price?: number | null;
    priceSmall?: number | null;
    priceLarge?: number | null;
  }): {
    price?: number | null;
    priceSmall?: number | null;
    priceLarge?: number | null;
  } {
    if (pricePayload.price !== undefined && pricePayload.price !== null) {
      return {
        price: pricePayload.price,
        priceSmall: null,
        priceLarge: null,
      };
    }

    if (
      (pricePayload.priceSmall !== undefined && pricePayload.priceSmall !== null) ||
      (pricePayload.priceLarge !== undefined && pricePayload.priceLarge !== null)
    ) {
      return {
        price: null,
        priceSmall: pricePayload.priceSmall ?? null,
        priceLarge: pricePayload.priceLarge ?? null,
      };
    }

    return {
      price: pricePayload.price,
      priceSmall: pricePayload.priceSmall,
      priceLarge: pricePayload.priceLarge,
    };
  }

  private async ensureUniqueSortOrder(
    category: string,
    sortOrder: number,
    excludeProductId?: string,
  ): Promise<void> {
    const duplicatedProduct = await this.prisma.product.findFirst({
      where: {
        category,
        sortOrder,
        ...(excludeProductId
          ? {
              id: {
                not: excludeProductId,
              },
            }
          : {}),
      },
      select: {
        id: true,
        name: true,
      },
    });

    if (!duplicatedProduct) {
      return;
    }

    throw new BadRequestException(
      `Sort order ${sortOrder} is already used in category "${category}".`,
    );
  }

  private async normalizeCategoryOrders(): Promise<void> {
    const products = await this.prisma.product.findMany({
      select: {
        category: true,
        categoryOrder: true,
        createdAt: true,
      },
      orderBy: [
        { categoryOrder: 'asc' },
        { createdAt: 'asc' },
        { category: 'asc' },
      ],
    });

    const orderedCategories: string[] = [];
    const seenCategories = new Set<string>();

    for (const product of products) {
      if (seenCategories.has(product.category)) {
        continue;
      }

      seenCategories.add(product.category);
      orderedCategories.push(product.category);
    }

    for (const [index, category] of orderedCategories.entries()) {
      await this.prisma.product.updateMany({
        where: { category },
        data: { categoryOrder: index + 1 },
      });
    }
  }

  private async getNextCategoryOrder(
    prisma: Pick<PrismaService, 'product'> = this.prisma,
  ): Promise<number> {
    const lastCategory = await prisma.product.findFirst({
      orderBy: [{ categoryOrder: 'desc' }],
      select: { categoryOrder: true },
    });

    return (lastCategory?.categoryOrder ?? 0) + 1;
  }

  private createProductId(): string {
    return `p_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  }
}



