import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Package, Calendar, DollarSign, User, Store } from "lucide-react";

export type OrderStatus = "pending" | "confirmed" | "shipped" | "delivered" | "cancelled";
export type ChannelType = "meli" | "falabella" | "amazon" | "shopify";

interface OrderCardProps {
  orderId: string;
  customerName: string;
  date: string;
  amount: number;
  status: OrderStatus;
  items: number;
  channel?: ChannelType;
}

const statusConfig: Record<OrderStatus, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending: { label: "Pendiente", variant: "outline" },
  confirmed: { label: "Confirmado", variant: "secondary" },
  shipped: { label: "Enviado", variant: "default" },
  delivered: { label: "Entregado", variant: "default" },
  cancelled: { label: "Cancelado", variant: "destructive" },
};

const channelConfig: Record<ChannelType, { label: string; color: string }> = {
  meli: { label: "Mercado Libre", color: "bg-yellow-500" },
  falabella: { label: "Falabella", color: "bg-green-500" },
  amazon: { label: "Amazon", color: "bg-orange-500" },
  shopify: { label: "Shopify", color: "bg-emerald-500" },
};

export const OrderCard = ({ orderId, customerName, date, amount, status, items, channel = "meli" }: OrderCardProps) => {
  return (
    <Card className="hover:shadow-lg transition-all duration-300 border-border">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="flex flex-col gap-2">
            <CardTitle className="text-lg font-semibold">#{orderId}</CardTitle>
            <div className="flex items-center gap-1.5">
              <div className={`w-2 h-2 rounded-full ${channelConfig[channel].color}`} />
              <span className="text-xs text-muted-foreground">{channelConfig[channel].label}</span>
            </div>
          </div>
          <Badge variant={statusConfig[status].variant}>
            {statusConfig[status].label}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <User className="w-4 h-4" />
          <span>{customerName}</span>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Calendar className="w-4 h-4" />
          <span>{date}</span>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Package className="w-4 h-4" />
          <span>{items} {items === 1 ? "producto" : "productos"}</span>
        </div>
        <div className="flex items-center gap-2 text-lg font-bold text-foreground pt-2 border-t border-border">
          <DollarSign className="w-5 h-5 text-primary" />
          <span>${amount.toLocaleString("es-AR")}</span>
        </div>
      </CardContent>
    </Card>
  );
};
