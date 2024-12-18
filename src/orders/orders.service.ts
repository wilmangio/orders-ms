import { HttpStatus, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { CreateOrderDto } from './dto/create-order.dto';
import { PrismaClient } from '@prisma/client';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { OrderPaginationDto } from './dto/pagination-order.dto';
import { ChangeOrderStatusDto } from './dto/change-order-status.dto';
import { NATS_SERVICE, PRODUCT_SERVICE } from 'src/config/services';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class OrdersService extends PrismaClient implements OnModuleInit {

  private readonly logger = new Logger('OrderService');

  constructor(
    @Inject(NATS_SERVICE) private readonly productsClient: ClientProxy,
  ){
    super();
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log(`Conectado a la base de datos de Postgres Ordenes`);
  }
  
  async create(createOrderDto: CreateOrderDto) {
    try{
      const productsId = createOrderDto.items.map( (item) => item.productId);
      const products:any[] = await firstValueFrom(
          this.productsClient.send({ cmd: 'validate_produts' }, productsId)
        );


      const totalAmount = createOrderDto.items.reduce( ( acc, orderItem) => {
          const price = products.find( 
            (product) => product.id === orderItem.productId,
          )
            .price;
          return acc +(price * orderItem.quantity);
      }, 0);

      const totalItems = createOrderDto.items.reduce((acc, orderItem) =>{
        return acc + orderItem.quantity;
      },0);

      //crear tarnsaccion de base de datos
      const order = await this.order.create({
        data: {
          totalAmount: totalAmount,
          totalItems: totalItems,
          OrderItem:{
            createMany:{
              data: createOrderDto.items.map( (orderItem ) =>({
                price: products.find( product => product.id === orderItem.productId).price,
                productId: orderItem.productId,
                quantity: orderItem.quantity,
              }))
            }
          }
        },
        include:{
          OrderItem: {
            select:{
              price: true,
              quantity: true,
              productId: true,
            }
          },
        }
      });

        return {
          ...order,
          OrderItem: order.OrderItem.map( (orderItem) =>({
              ...orderItem,
              name: products.find( product => product.id === orderItem.productId).name,
          }))
        };
    }catch( error ){
      throw new RpcException({
        status: HttpStatus.BAD_REQUEST,
        message: `Error al momento de crear producto`,
      });
    }
  }

  async findAll( orderPaginationDto: OrderPaginationDto) {
    const { page, limit, status }  = orderPaginationDto;
    const totalPages = await this.order.count({ where: {status: status}});
    const lastPage = Math.ceil( totalPages / limit);
    return {
      data: await this.order.findMany({
        take: limit,
        skip: ( page - 1) * limit,
        where:{
          status: status
        }
      }),
      meta:{
        page: page,
        total: totalPages,
        lastPage: lastPage,
      }
    } 
  }

  async findOne(id: string) {
    const orderId = await this.order.findFirst({ 
      where: { id: id },
      include:{
        OrderItem: {
          select:{
            price: true,
            quantity: true,
            productId: true,
          }
        },
      }
    });
    if( !orderId ){
      throw new RpcException({
        message: `No encontrado  #${id} orderId`,
        status: HttpStatus.NOT_FOUND,
      });
    }

    const productsId = orderId.OrderItem.map( orderItem => orderItem.productId);
    const products:any[] = await firstValueFrom(
      this.productsClient.send({ cmd: 'validate_produts' }, productsId)
    );


    return {
      ...orderId,
      OrderItem: orderId.OrderItem.map( orderItem => ({
        ...orderItem,
        name: products.find( product => product.id === orderItem.productId).name,
      }))
    };
  }

  async changeStatus( changeOrderStatusDto:ChangeOrderStatusDto ){
    const {id, status } = changeOrderStatusDto;
    const order = await this.findOne(id);
    if( order.status === status){
      return order;
    }

    return this.order.update({
      where: { id },
      data: { status: status }
    });

  } 
}
