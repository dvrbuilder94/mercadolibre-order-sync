import { OrderStatus, ChannelType } from "@/components/OrderCard";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Package, Calendar, DollarSign } from "lucide-react";

interface Order {
  id: string;
  order_id: string;
  customer_name: string;
  order_date: string;
  amount: number;
  status: OrderStatus;
  items: number;
  channel: ChannelType;
}

interface OrdersTableProps {
  orders: Order[];
}

const statusConfig: Record<OrderStatus, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending: { label: "Pendiente", variant: "secondary" },
  confirmed: { label: "Confirmado", variant: "default" },
  shipped: { label: "Enviado", variant: "outline" },
  delivered: { label: "Entregado", variant: "default" },
  cancelled: { label: "Cancelado", variant: "destructive" },
};

const channelConfig: Record<ChannelType, { label: string; color: string }> = {
  meli: { label: "Mercado Libre", color: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400" },
  falabella: { label: "Falabella", color: "bg-green-500/10 text-green-700 dark:text-green-400" },
  amazon: { label: "Amazon", color: "bg-orange-500/10 text-orange-700 dark:text-orange-400" },
  shopify: { label: "Shopify", color: "bg-purple-500/10 text-purple-700 dark:text-purple-400" },
};

export const OrdersTable = ({ orders }: OrdersTableProps) => {
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Canal</TableHead>
            <TableHead>ID Orden</TableHead>
            <TableHead>Cliente</TableHead>
            <TableHead>Fecha</TableHead>
            <TableHead className="text-right">Monto</TableHead>
            <TableHead className="text-center">Items</TableHead>
            <TableHead>Estado</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {orders.map((order) => (
            <TableRow key={order.id}>
              <TableCell>
                <Badge variant="outline" className={channelConfig[order.channel].color}>
                  {channelConfig[order.channel].label}
                </Badge>
              </TableCell>
              <TableCell className="font-mono text-sm">{order.order_id}</TableCell>
              <TableCell>{order.customer_name}</TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm">
                    {new Date(order.order_date).toLocaleDateString('es-AR', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}
                  </span>
                </div>
              </TableCell>
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-2">
                  <DollarSign className="h-4 w-4 text-muted-foreground" />
                  <span className="font-semibold">
                    {new Intl.NumberFormat('es-AR', {
                      style: 'currency',
                      currency: 'ARS',
                    }).format(Number(order.amount))}
                  </span>
                </div>
              </TableCell>
              <TableCell className="text-center">
                <div className="flex items-center justify-center gap-2">
                  <Package className="h-4 w-4 text-muted-foreground" />
                  <span>{order.items}</span>
                </div>
              </TableCell>
              <TableCell>
                <Badge variant={statusConfig[order.status].variant}>
                  {statusConfig[order.status].label}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
};
