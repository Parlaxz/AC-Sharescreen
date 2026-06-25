import * as React from "react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

const galleryQueryParam = "gallery";

export function ComponentGallery() {
  const [searchParams] = useState(() => new URLSearchParams(window.location.search));
  const show = searchParams.get(galleryQueryParam) === "1";
  if (!show) return null;

  return <Gallery />;
}

function Gallery() {
  const [open, setOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [sliderValue, setSliderValue] = useState([50]);
  const [progressValue, setProgressValue] = useState(65);
  const [switchChecked, setSwitchChecked] = useState(false);

  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setCommandOpen((prev) => !prev);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);

  return (
    <div className="min-h-screen bg-canvas p-8 text-text-primary font-sans">
      <Toaster />
      <style>{`
        .gallery-section { margin-bottom: 2rem; }
        .gallery-section h2 {
          font-size: 1.25rem;
          font-weight: 600;
          margin-bottom: 1rem;
          color: var(--color-text-primary, #F1F4F8);
          border-bottom: 1px solid var(--color-border-subtle, #292F39);
          padding-bottom: 0.5rem;
        }
        .gallery-row {
          display: flex;
          flex-wrap: wrap;
          gap: 0.75rem;
          align-items: center;
          margin-bottom: 1rem;
        }
        .gallery-label {
          font-size: 0.75rem;
          color: var(--color-text-muted, #727D8E);
          min-width: 100px;
          flex-shrink: 0;
        }
      `}</style>

      <div className="max-w-5xl mx-auto">
        <h1 className="text-2xl font-semibold mb-2">ScreenLink Component Gallery</h1>
        <p className="text-text-secondary mb-8">
          Visual regression reference for all Watermelon components with ScreenLink design tokens.
        </p>

        {/* ─── Button ──────────────────────────────────────────────── */}
        <section className="gallery-section">
          <h2>Button</h2>
          <div className="gallery-row">
            <span className="gallery-label">default</span>
            <Button>Default</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="destructive">Destructive</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="link">Link</Button>
          </div>
          <div className="gallery-row">
            <span className="gallery-label">sizes</span>
            <Button size="sm">Small</Button>
            <Button size="default">Default</Button>
            <Button size="lg">Large</Button>
            <Button size="icon">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>
            </Button>
          </div>
          <div className="gallery-row">
            <span className="gallery-label">disabled</span>
            <Button disabled>Disabled</Button>
            <Button disabled variant="destructive">Disabled</Button>
          </div>
        </section>

        {/* ─── Badge ──────────────────────────────────────────────── */}
        <section className="gallery-section">
          <h2>Badge</h2>
          <div className="gallery-row">
            <span className="gallery-label">variants</span>
            <Badge>Default</Badge>
            <Badge variant="secondary">Secondary</Badge>
            <Badge variant="destructive">Destructive</Badge>
            <Badge variant="success">Success</Badge>
            <Badge variant="warning">Warning</Badge>
            <Badge variant="outline">Outline</Badge>
          </div>
        </section>

        {/* ─── Card ───────────────────────────────────────────────── */}
        <section className="gallery-section">
          <h2>Card</h2>
          <div className="gallery-row" style={{ maxWidth: 400 }}>
            <Card>
              <CardHeader>
                <CardTitle>Card Title</CardTitle>
                <CardDescription>Card description text</CardDescription>
              </CardHeader>
              <CardContent>
                <p>Card content area with body text.</p>
              </CardContent>
              <CardFooter>
                <Button>Action</Button>
              </CardFooter>
            </Card>
          </div>
        </section>

        {/* ─── Avatar ─────────────────────────────────────────────── */}
        <section className="gallery-section">
          <h2>Avatar</h2>
          <div className="gallery-row">
            <span className="gallery-label">variants</span>
            <Avatar>
              <AvatarImage src="https://github.com/shadcn.png" alt="@user" />
              <AvatarFallback>CN</AvatarFallback>
            </Avatar>
            <Avatar>
              <AvatarFallback>SL</AvatarFallback>
            </Avatar>
          </div>
        </section>

        {/* ─── Tooltip ────────────────────────────────────────────── */}
        <section className="gallery-section">
          <h2>Tooltip</h2>
          <div className="gallery-row">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline">Hover me</Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Tooltip content</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </section>

        {/* ─── Dialog ─────────────────────────────────────────────── */}
        <section className="gallery-section">
          <h2>Dialog</h2>
          <div className="gallery-row">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline">Open Dialog</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Dialog Title</DialogTitle>
                  <DialogDescription>Dialog description goes here.</DialogDescription>
                </DialogHeader>
                <p>Dialog body content.</p>
                <DialogFooter>
                  <Button variant="outline">Cancel</Button>
                  <Button>Confirm</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </section>

        {/* ─── Sheet ──────────────────────────────────────────────── */}
        <section className="gallery-section">
          <h2>Sheet</h2>
          <div className="gallery-row">
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="outline">Open Sheet</Button>
              </SheetTrigger>
              <SheetContent>
                <SheetHeader>
                  <SheetTitle>Sheet Title</SheetTitle>
                  <SheetDescription>Sheet description.</SheetDescription>
                </SheetHeader>
                <p className="py-4">Sheet body content.</p>
              </SheetContent>
            </Sheet>
          </div>
        </section>

        {/* ─── Dropdown Menu ──────────────────────────────────────── */}
        <section className="gallery-section">
          <h2>Dropdown Menu</h2>
          <div className="gallery-row">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">Open Menu</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuLabel>Account</DropdownMenuLabel>
                <DropdownMenuItem>Profile</DropdownMenuItem>
                <DropdownMenuItem>Settings</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem>Logout</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </section>

        {/* ─── Context Menu ───────────────────────────────────────── */}
        <section className="gallery-section">
          <h2>Context Menu</h2>
          <div className="gallery-row">
            <ContextMenu>
              <ContextMenuTrigger className="flex h-[100px] w-[250px] items-center justify-center rounded-standard border border-dashed border-border-subtle bg-surface-2 text-sm text-text-muted">
                Right click here
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem>Edit</ContextMenuItem>
                <ContextMenuItem>Delete</ContextMenuItem>
                <ContextMenuItem>Copy</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          </div>
        </section>

        {/* ─── Popover ────────────────────────────────────────────── */}
        <section className="gallery-section">
          <h2>Popover</h2>
          <div className="gallery-row">
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline">Open Popover</Button>
              </PopoverTrigger>
              <PopoverContent>
                <p>Popover content here.</p>
              </PopoverContent>
            </Popover>
          </div>
        </section>

        {/* ─── Tabs ───────────────────────────────────────────────── */}
        <section className="gallery-section">
          <h2>Tabs</h2>
          <Tabs defaultValue="tab1">
            <TabsList>
              <TabsTrigger value="tab1">Tab 1</TabsTrigger>
              <TabsTrigger value="tab2">Tab 2</TabsTrigger>
              <TabsTrigger value="tab3">Tab 3</TabsTrigger>
            </TabsList>
            <TabsContent value="tab1">Tab 1 content</TabsContent>
            <TabsContent value="tab2">Tab 2 content</TabsContent>
            <TabsContent value="tab3">Tab 3 content</TabsContent>
          </Tabs>
        </section>

        {/* ─── Separator ──────────────────────────────────────────── */}
        <section className="gallery-section">
          <h2>Separator</h2>
          <div className="gallery-row">
            <Separator className="w-full" />
          </div>
        </section>

        {/* ─── Scroll Area ────────────────────────────────────────── */}
        <section className="gallery-section">
          <h2>Scroll Area</h2>
          <ScrollArea className="h-[100px] w-[300px] rounded-standard border border-border-subtle p-2">
            <div className="space-y-1">
              {Array.from({ length: 20 }, (_, i) => (
                <p key={i} className="text-sm text-text-secondary">
                  Item {i + 1}
                </p>
              ))}
            </div>
          </ScrollArea>
        </section>

        {/* ─── Skeleton ───────────────────────────────────────────── */}
        <section className="gallery-section">
          <h2>Skeleton</h2>
          <div className="gallery-row">
            <div className="flex items-center gap-3">
              <Skeleton className="h-10 w-10 rounded-full" />
              <div className="space-y-2">
                <Skeleton className="h-4 w-[200px]" />
                <Skeleton className="h-4 w-[150px]" />
              </div>
            </div>
          </div>
        </section>

        {/* ─── Toast ──────────────────────────────────────────────── */}
        <section className="gallery-section">
          <h2>Toast (Sonner)</h2>
          <div className="gallery-row">
            <Button
              variant="outline"
              onClick={() => toast("Event has been created", { description: "Description of the event." })}
            >
              Show Toast
            </Button>
            <Button
              variant="outline"
              onClick={() => toast.success("Success!", { description: "Operation completed." })}
            >
              Success Toast
            </Button>
            <Button
              variant="outline"
              onClick={() => toast.error("Error occurred", { description: "Something went wrong." })}
            >
              Error Toast
            </Button>
          </div>
        </section>

        {/* ─── Select ─────────────────────────────────────────────── */}
        <section className="gallery-section">
          <h2>Select</h2>
          <div className="gallery-row">
            <Select>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Select option" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">Option 1</SelectItem>
                <SelectItem value="2">Option 2</SelectItem>
                <SelectItem value="3">Option 3</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </section>

        {/* ─── Switch ─────────────────────────────────────────────── */}
        <section className="gallery-section">
          <h2>Switch</h2>
          <div className="gallery-row">
            <span className="gallery-label">off / on</span>
            <Switch checked={switchChecked} onCheckedChange={setSwitchChecked} />
            <span className="text-sm text-text-secondary">
              {switchChecked ? "Enabled" : "Disabled"}
            </span>
          </div>
        </section>

        {/* ─── Slider ─────────────────────────────────────────────── */}
        <section className="gallery-section">
          <h2>Slider</h2>
          <div className="gallery-row" style={{ maxWidth: 300 }}>
            <Slider
              value={sliderValue}
              onValueChange={setSliderValue}
              max={100}
              step={1}
            />
            <span className="text-sm text-text-mono font-tnum">{sliderValue[0]}</span>
          </div>
        </section>

        {/* ─── Progress ───────────────────────────────────────────── */}
        <section className="gallery-section">
          <h2>Progress</h2>
          <div className="gallery-row" style={{ maxWidth: 300 }}>
            <Progress value={progressValue} />
            <span className="text-sm text-text-mono font-tnum">{progressValue}%</span>
          </div>
        </section>

        {/* ─── Input ──────────────────────────────────────────────── */}
        <section className="gallery-section">
          <h2>Input</h2>
          <div className="gallery-row" style={{ maxWidth: 300 }}>
            <Input placeholder="Enter text..." />
          </div>
          <div className="gallery-row" style={{ maxWidth: 300 }}>
            <Input disabled placeholder="Disabled input" />
          </div>
        </section>

        {/* ─── Label ──────────────────────────────────────────────── */}
        <section className="gallery-section">
          <h2>Label</h2>
          <div className="gallery-row">
            <Label htmlFor="demo-input">Label text</Label>
            <Input id="demo-input" placeholder="Labeled input" className="max-w-[200px]" />
          </div>
        </section>

        {/* ─── Checkbox ───────────────────────────────────────────── */}
        <section className="gallery-section">
          <h2>Checkbox</h2>
          <div className="gallery-row">
            <div className="flex items-center gap-2">
              <Checkbox id="c1" />
              <Label htmlFor="c1">Option label</Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox id="c2" defaultChecked />
              <Label htmlFor="c2">Checked option</Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox id="c3" disabled />
              <Label htmlFor="c3" className="text-text-muted">Disabled</Label>
            </div>
          </div>
        </section>

        {/* ─── Radio Group ────────────────────────────────────────── */}
        <section className="gallery-section">
          <h2>Radio Group</h2>
          <div className="gallery-row">
            <RadioGroup defaultValue="a">
              <div className="flex items-center gap-2">
                <RadioGroupItem value="a" id="r1" />
                <Label htmlFor="r1">Option A</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="b" id="r2" />
                <Label htmlFor="r2">Option B</Label>
              </div>
            </RadioGroup>
          </div>
        </section>

        {/* ─── Command Palette ────────────────────────────────────── */}
        <section className="gallery-section">
          <h2>Command Palette</h2>
          <div className="gallery-row">
            <Button variant="outline" onClick={() => setCommandOpen(true)}>
              Open Command Palette (Ctrl+K)
            </Button>
            <CommandDialog open={commandOpen} onOpenChange={setCommandOpen}>
              <CommandInput placeholder="Type a command..." />
              <CommandList>
                <CommandEmpty>No results found.</CommandEmpty>
                <CommandGroup heading="Navigation">
                  <CommandItem onSelect={() => setCommandOpen(false)}>Dashboard</CommandItem>
                  <CommandItem onSelect={() => setCommandOpen(false)}>Groups</CommandItem>
                  <CommandItem onSelect={() => setCommandOpen(false)}>Settings</CommandItem>
                </CommandGroup>
                <CommandGroup heading="Actions">
                  <CommandItem onSelect={() => setCommandOpen(false)}>Start Sharing</CommandItem>
                  <CommandItem onSelect={() => setCommandOpen(false)}>Invite Members</CommandItem>
                </CommandGroup>
              </CommandList>
            </CommandDialog>
          </div>
        </section>

        {/* ─── Resizable Panels ───────────────────────────────────── */}
        <section className="gallery-section">
          <h2>Resizable Panels</h2>
          <div className="flex h-[150px] max-w-[500px] rounded-standard border border-border-subtle overflow-hidden">
            <ResizablePanel className="flex items-center justify-center p-2 text-sm text-text-muted">
              Panel A
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel className="flex items-center justify-center p-2 text-sm text-text-muted">
              Panel B
            </ResizablePanel>
          </div>
        </section>

        {/* ─── Alert ──────────────────────────────────────────────── */}
        <section className="gallery-section">
          <h2>Alert</h2>
          <div className="space-y-2 max-w-[500px]">
            <Alert>
              <AlertTitle>Default Alert</AlertTitle>
              <AlertDescription>This is a default alert message.</AlertDescription>
            </Alert>
            <Alert variant="destructive">
              <AlertTitle>Error</AlertTitle>
              <AlertDescription>This is a destructive alert.</AlertDescription>
            </Alert>
            <Alert variant="warning">
              <AlertTitle>Warning</AlertTitle>
              <AlertDescription>This is a warning alert.</AlertDescription>
            </Alert>
            <Alert variant="success">
              <AlertTitle>Success</AlertTitle>
              <AlertDescription>Operation completed successfully.</AlertDescription>
            </Alert>
          </div>
        </section>
      </div>
    </div>
  );
}
