import { createComponentImplementation } from "@a2ui/react/v0_9";
import { ModalApi } from "@a2ui/web_core/v0_9/basic_catalog";

import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";

export const Modal = createComponentImplementation(
  ModalApi,
  ({ props, buildChild }) => {
    return (
      <Dialog>
        <DialogTrigger
          render={<span className="inline-block" />}
          nativeButton={false}
        >
          {props.trigger ? buildChild(props.trigger) : null}
        </DialogTrigger>
        <DialogContent className="max-h-[90vh] overflow-auto">
          {props.content ? buildChild(props.content) : null}
        </DialogContent>
      </Dialog>
    );
  },
);
