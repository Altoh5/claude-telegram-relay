---
name: pdf-to-pptx-canva
description: Convert a PDF file to PowerPoint (.pptx) format using Canva's browser interface. Use this skill whenever the user wants to convert a PDF to PowerPoint/PPTX, extract text from a PDF using Canva, or transform a PDF presentation into an editable slide deck. Trigger when user mentions "PDF to PowerPoint", "convert PDF to PPTX", "PDF to slides", or asks to use Canva to process a PDF file.
---

# PDF to PPTX via Canva

Converts a PDF file to PowerPoint format by uploading it to Canva, extracting text from each page using Canva's "Grab Text" tool, and downloading the result as a .pptx file.

## Required Inputs

- **PDF file path**: The local file path to the PDF to be uploaded and processed.

## Workflow

### 1. Navigate to Canva

Go to [www.canva.com](https://www.canva.com). The homepage shows a "What will you design today?" header with creation options.

### 2. Open Upload Interface

- Click the **"+" (Create)** button (purple plus icon) in the left sidebar
- In the "Create a design" modal, click the **"Upload"** tab at the top
- Click the **"Upload files"** button (large teal cloud icon with upward arrow)
- Select and upload the specified PDF file

### 3. Wait for PDF to Open

Wait for the PDF to finish uploading and open in Canva's editor.

### 4. Extract Text from Each Page

Repeat the following for **every page** in the document:

1. Click on the page
2. Click **"Edit"** in the top toolbar (dark toolbar with BG Remover, Eraser, etc.)
3. In the left sidebar ("Edit image" panel), click **"Grab Text"** (pencil/text icon under Magic Studio tools)
4. In the "Grab Text" panel, click **"All text"** (large circular blue button)
5. Click **"Grab"** to extract the text
6. Navigate to the **next page** using the page navigation at the bottom

Continue until all pages are processed.

### 5. Download as PPTX

1. Click the **"Share"** button in the top-right corner (purple button)
2. In the Share menu, scroll down and click **"Download"**
3. In the download popup, select **File Type → PPTX**
4. Click **"Download"**

## Notes

- Be patient — PDF upload and text extraction can take time for large documents
- Ensure you process every page before downloading
- The resulting .pptx will contain the extracted text in editable slide format
