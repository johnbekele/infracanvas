import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Server,
  Database,
  Globe,
  Shield,
  Zap,
  Bell,
  Inbox,
  GitBranch,
  Users,
  Table,
  Network,
  Box,
  ChevronDown,
  Search,
  GripVertical,
} from 'lucide-react';
import { awsServices, serviceCategories, type AWSService } from '@infracanvas/core';
import { Input } from '@/components/ui/input';

const iconMap: Record<string, React.ElementType> = {
  server: Server,
  database: Database,
  globe: Globe,
  shield: Shield,
  zap: Zap,
  bell: Bell,
  inbox: Inbox,
  'git-branch': GitBranch,
  users: Users,
  table: Table,
  network: Network,
  container: Box,
};

interface ServicePaletteProps {
  onDragStart: (event: React.DragEvent, service: AWSService) => void;
}

export function ServicePalette({ onDragStart }: ServicePaletteProps) {
  const [search, setSearch] = useState('');
  const [expandedCategories, setExpandedCategories] = useState<string[]>(
    serviceCategories.map((c) => c.id)
  );

  const toggleCategory = (categoryId: string) => {
    setExpandedCategories((prev) =>
      prev.includes(categoryId) ? prev.filter((c) => c !== categoryId) : [...prev, categoryId]
    );
  };

  const filteredServices = awsServices.filter(
    (service) =>
      service.name.toLowerCase().includes(search.toLowerCase()) ||
      service.description.toLowerCase().includes(search.toLowerCase())
  );

  const groupedServices = serviceCategories.reduce(
    (acc, category) => {
      acc[category.id] = filteredServices.filter((s) => s.category === category.id);
      return acc;
    },
    {} as Record<string, AWSService[]>
  );

  return (
    <div className="flex h-full w-64 flex-col border-r border-gray-200 bg-white md:w-64 dark:border-gray-800 dark:bg-gray-900">
      {/* Header */}
      <div className="border-b border-gray-200 p-3 md:p-4 dark:border-gray-800">
        <h2 className="mb-2 text-sm font-semibold text-gray-900 md:mb-3 md:text-base dark:text-white">
          AWS Services
        </h2>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <Input
            placeholder="Search services..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 pl-9 text-xs md:h-9 md:text-sm"
          />
        </div>
      </div>

      {/* Service List */}
      <div className="flex-1 overflow-y-auto p-2">
        {serviceCategories.map((category) => {
          const services = groupedServices[category.id];
          if (services.length === 0) return null;

          const isExpanded = expandedCategories.includes(category.id);

          return (
            <div key={category.id} className="mb-2">
              {/* Category Header */}
              <button
                onClick={() => toggleCategory(category.id)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                <div className="h-2 w-2 rounded-full" style={{ backgroundColor: category.color }} />
                <span className="flex-1 text-left text-sm font-medium text-gray-700 dark:text-gray-300">
                  {category.name}
                </span>
                <span className="text-xs text-gray-400">{services.length}</span>
                <ChevronDown
                  className={`h-4 w-4 text-gray-400 transition-transform ${
                    isExpanded ? 'rotate-180' : ''
                  }`}
                />
              </button>

              {/* Services */}
              <AnimatePresence>
                {isExpanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden"
                  >
                    <div className="space-y-1 py-1 pl-4">
                      {services.map((service) => {
                        const Icon = iconMap[service.icon] || Server;
                        return (
                          <div
                            key={service.id}
                            draggable
                            onDragStart={(e) => onDragStart(e, service)}
                            className="group flex cursor-grab items-center gap-2 rounded-lg border border-transparent bg-gray-50 px-2 py-2 transition-colors hover:border-gray-200 hover:bg-gray-100 active:cursor-grabbing dark:bg-gray-800/50 dark:hover:border-gray-700 dark:hover:bg-gray-800"
                          >
                            <GripVertical className="h-3 w-3 text-gray-300 opacity-0 transition-opacity group-hover:opacity-100 dark:text-gray-600" />
                            <div
                              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
                              style={{ backgroundColor: service.color }}
                            >
                              <Icon className="h-3.5 w-3.5 text-white" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-xs font-medium text-gray-900 dark:text-white">
                                {service.name}
                              </p>
                              <p className="truncate text-[10px] text-gray-500 dark:text-gray-400">
                                {service.description}
                              </p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}

        {filteredServices.length === 0 && (
          <div className="py-8 text-center text-sm text-gray-500">No services found</div>
        )}
      </div>

      {/* Help Text */}
      <div className="border-t border-gray-200 p-2 md:p-3 dark:border-gray-800">
        <p className="text-center text-[10px] text-gray-500 dark:text-gray-400">
          Drag services onto the canvas
        </p>
      </div>
    </div>
  );
}
