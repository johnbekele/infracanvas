import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Server, Database, Globe, Shield, Zap, Bell,
  Inbox, GitBranch, Users, Table, Network, Box,
  ChevronDown, Search, GripVertical
} from 'lucide-react';
import { awsServices, serviceCategories, AWSService } from '@infracanvas/core';
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
      prev.includes(categoryId)
        ? prev.filter((c) => c !== categoryId)
        : [...prev, categoryId]
    );
  };

  const filteredServices = awsServices.filter(
    (service) =>
      service.name.toLowerCase().includes(search.toLowerCase()) ||
      service.description.toLowerCase().includes(search.toLowerCase())
  );

  const groupedServices = serviceCategories.reduce((acc, category) => {
    acc[category.id] = filteredServices.filter((s) => s.category === category.id);
    return acc;
  }, {} as Record<string, AWSService[]>);

  return (
    <div className="w-64 md:w-64 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 flex flex-col h-full">
      {/* Header */}
      <div className="p-3 md:p-4 border-b border-gray-200 dark:border-gray-800">
        <h2 className="font-semibold text-gray-900 dark:text-white mb-2 md:mb-3 text-sm md:text-base">
          AWS Services
        </h2>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <Input
            placeholder="Search services..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-8 md:h-9 text-xs md:text-sm"
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
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              >
                <div
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: category.color }}
                />
                <span className="flex-1 text-left text-sm font-medium text-gray-700 dark:text-gray-300">
                  {category.name}
                </span>
                <span className="text-xs text-gray-400">{services.length}</span>
                <ChevronDown
                  className={`w-4 h-4 text-gray-400 transition-transform ${
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
                    <div className="pl-4 py-1 space-y-1">
                      {services.map((service) => {
                        const Icon = iconMap[service.icon] || Server;
                        return (
                          <div
                            key={service.id}
                            draggable
                            onDragStart={(e) => onDragStart(e, service)}
                            className="flex items-center gap-2 px-2 py-2 rounded-lg bg-gray-50 dark:bg-gray-800/50 hover:bg-gray-100 dark:hover:bg-gray-800 cursor-grab active:cursor-grabbing transition-colors group border border-transparent hover:border-gray-200 dark:hover:border-gray-700"
                          >
                            <GripVertical className="w-3 h-3 text-gray-300 dark:text-gray-600 opacity-0 group-hover:opacity-100 transition-opacity" />
                            <div
                              className="w-7 h-7 rounded-md flex items-center justify-center shrink-0"
                              style={{ backgroundColor: service.color }}
                            >
                              <Icon className="w-3.5 h-3.5 text-white" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-medium text-gray-900 dark:text-white truncate">
                                {service.name}
                              </p>
                              <p className="text-[10px] text-gray-500 dark:text-gray-400 truncate">
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
          <div className="text-center py-8 text-sm text-gray-500">
            No services found
          </div>
        )}
      </div>

      {/* Help Text */}
      <div className="p-2 md:p-3 border-t border-gray-200 dark:border-gray-800">
        <p className="text-[10px] text-gray-500 dark:text-gray-400 text-center">
          Drag services onto the canvas
        </p>
      </div>
    </div>
  );
}
