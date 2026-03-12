UUID = asus-gpu-control@alhnesn
EXTENSION_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

SOURCES = extension.js metadata.json

.PHONY: install uninstall zip clean

install: $(SOURCES)
	mkdir -p $(EXTENSION_DIR)
	cp $(SOURCES) $(EXTENSION_DIR)/

uninstall:
	rm -rf $(EXTENSION_DIR)

zip: $(SOURCES)
	zip -j $(UUID).zip $(SOURCES)

clean:
	rm -f $(UUID).zip
