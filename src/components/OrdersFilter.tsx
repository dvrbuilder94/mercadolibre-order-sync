import { OrderStatus, ChannelType } from "./OrderCard";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { CalendarIcon, X } from "lucide-react";
import { format } from "date-fns";
import { DateRange } from "react-day-picker";
import { cn } from "@/lib/utils";

interface OrdersFilterProps {
  activeStatusFilter: OrderStatus | "all";
  activeChannelFilter: ChannelType | "all";
  dateRange: DateRange | undefined;
  onStatusFilterChange: (filter: OrderStatus | "all") => void;
  onChannelFilterChange: (filter: ChannelType | "all") => void;
  onDateRangeChange: (range: DateRange | undefined) => void;
}

const statusFilters = [
  { value: "all", label: "Todos los estados" },
  { value: "pending", label: "Pendientes" },
  { value: "confirmed", label: "Confirmadas" },
  { value: "shipped", label: "Enviadas" },
  { value: "delivered", label: "Entregadas" },
];

const channelFilters = [
  { value: "all", label: "Todos los canales" },
  { value: "meli", label: "Mercado Libre" },
  { value: "falabella", label: "Falabella" },
  { value: "amazon", label: "Amazon" },
  { value: "shopify", label: "Shopify" },
];

export const OrdersFilter = ({ 
  activeStatusFilter, 
  activeChannelFilter,
  dateRange,
  onStatusFilterChange,
  onChannelFilterChange,
  onDateRangeChange
}: OrdersFilterProps) => {
  return (
    <div className="flex flex-wrap gap-3 items-end">
      <div className="flex-1 min-w-[200px]">
        <label className="text-sm font-medium mb-1.5 block">Estado</label>
        <Select value={activeStatusFilter} onValueChange={(value) => onStatusFilterChange(value as OrderStatus | "all")}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {statusFilters.map((filter) => (
              <SelectItem key={filter.value} value={filter.value}>
                {filter.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex-1 min-w-[200px]">
        <label className="text-sm font-medium mb-1.5 block">Canal</label>
        <Select value={activeChannelFilter} onValueChange={(value) => onChannelFilterChange(value as ChannelType | "all")}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {channelFilters.map((filter) => (
              <SelectItem key={filter.value} value={filter.value}>
                {filter.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex-1 min-w-[250px]">
        <label className="text-sm font-medium mb-1.5 block">Fecha</label>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              className={cn(
                "w-full justify-start text-left font-normal",
                !dateRange && "text-muted-foreground"
              )}
            >
              <CalendarIcon className="mr-2 h-4 w-4" />
              {dateRange?.from ? (
                dateRange.to ? (
                  <>
                    {format(dateRange.from, "dd/MM/yyyy")} - {format(dateRange.to, "dd/MM/yyyy")}
                  </>
                ) : (
                  format(dateRange.from, "dd/MM/yyyy")
                )
              ) : (
                <span>Seleccionar rango</span>
              )}
              {dateRange?.from && (
                <X 
                  className="ml-auto h-4 w-4 hover:text-destructive" 
                  onClick={(e) => {
                    e.stopPropagation();
                    onDateRangeChange(undefined);
                  }}
                />
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              initialFocus
              mode="range"
              defaultMonth={dateRange?.from}
              selected={dateRange}
              onSelect={onDateRangeChange}
              numberOfMonths={2}
              className="pointer-events-auto"
            />
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
};
